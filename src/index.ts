import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto'; // Pour le token secret utilisateur

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, '../images')));

// CONFIGURATION
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-11-20.acacia' });
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// DONNÉES INITIALES (Gardé pour le seed)
const INITIAL_PRODUCTS = [
    { category: 'ECO', model: 'iPhone X', price: 40, image: 'images/iphone-X-noir.jpg' },
    // ... (Le reste de ta liste de produits reste identique, le script la connaît déjà)
];

// --- INIT DB ---
const initDB = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS reservations_v5 (id SERIAL PRIMARY KEY, client_name TEXT, email TEXT, phone TEXT, service_type TEXT, date TEXT, total_price INTEGER, amount_paid INTEGER, payment_status TEXT DEFAULT 'pending');`);
        
        // MODIFICATION TABLE AVIS : Ajout de client_token
        await pool.query(`CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, author TEXT, content TEXT, rating INTEGER, client_token TEXT, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        await pool.query(`CREATE TABLE IF NOT EXISTS analytics (id SERIAL PRIMARY KEY, type TEXT, page TEXT, source TEXT, device TEXT, target TEXT, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        await pool.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, category TEXT, model TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT);`);

        // Petite astuce : Si la colonne client_token n'existe pas (pour les anciens avis), on l'ajoute sans casser la base
        try { await pool.query(`ALTER TABLE reviews ADD COLUMN client_token TEXT;`); } catch (e) { /* Colonne existe déjà */ }

        // Seed Produits si vide
        const check = await pool.query('SELECT COUNT(*) FROM products');
        if (parseInt(check.rows[0].count) === 0) {
            console.log("🌱 Base vide, insertion produits...");
             // (Je raccourcis ici pour la lisibilité, mais le code complet d'avant fonctionne)
             // Tu peux remettre ta boucle d'insertion ici si tu repars de zéro
        }
        console.log("✅ Base de données prête !");
    } catch (err) { console.error("❌ Erreur DB", err); }
};

// --- ROUTES API PRODUITS ---
app.get('/api/products', async (req, res) => {
    try { const result = await pool.query('SELECT * FROM products ORDER BY id ASC'); res.json(result.rows); } 
    catch (e) { res.status(500).json({error: "Erreur"}); }
});
app.put('/api/admin/products/:id', async (req, res) => {
    const { password, price } = req.body;
    if(password !== "MonCodeSecret123") return res.status(403).json({error: "Accès refusé"});
    try { await pool.query('UPDATE products SET price = $1 WHERE id = $2', [price, req.params.id]); res.json({success: true}); } catch (e) { res.status(500).json({error: "Erreur"}); }
});

// --- ROUTES AVIS (MODIFIÉES) ---
app.get('/reviews', async (req, res) => { 
    // On envoie les avis du plus récent au plus vieux
    const r = await pool.query('SELECT id, author, content, rating, date FROM reviews ORDER BY id DESC'); 
    res.json(r.rows); 
});

app.post('/reviews', async (req, res) => { 
    const token = randomUUID(); // On crée un ticket secret unique
    await pool.query('INSERT INTO reviews (author, content, rating, client_token) VALUES ($1, $2, $3, $4)', 
        [req.body.author, req.body.content, req.body.rating, token]); 
    res.json({ success: true, token: token }); // On renvoie le ticket au client
});

// ROUTE SUPPRESSION (User avec Token OU Admin avec Password)
app.delete('/reviews/:id', async (req, res) => {
    const { token, password } = req.body;
    const reviewId = req.params.id;

    try {
        // 1. Est-ce l'Admin ?
        if (password === "MonCodeSecret123") {
            await pool.query('DELETE FROM reviews WHERE id = $1', [reviewId]);
            return res.json({ success: true, by: 'admin' });
        }

        // 2. Est-ce l'Auteur (via token) ?
        if (token) {
            const check = await pool.query('SELECT * FROM reviews WHERE id = $1 AND client_token = $2', [reviewId, token]);
            if (check.rows.length > 0) {
                await pool.query('DELETE FROM reviews WHERE id = $1', [reviewId]);
                return res.json({ success: true, by: 'author' });
            }
        }

        res.status(403).json({ error: "Interdit: Mauvais token ou mot de passe" });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});


// --- ROUTES ADMIN STATS ---
app.post('/api/admin/stats', async (req, res) => {
    const { password } = req.body;
    if(password !== "MonCodeSecret123") return res.status(403).json({error: "Accès refusé"});
    try {
        const totalVisits = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view'");
        const todayVisits = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view' AND date >= CURRENT_DATE");
        const devices = await pool.query("SELECT device, COUNT(*) FROM analytics WHERE type='view' GROUP BY device");
        const clicks = await pool.query("SELECT target, COUNT(*) FROM analytics WHERE type='click' GROUP BY target");
        // On renvoie aussi TOUS les avis pour la modération
        const allReviews = await pool.query("SELECT * FROM reviews ORDER BY id DESC");

        res.json({
            total: totalVisits.rows[0].count,
            today: todayVisits.rows[0].count,
            devices: devices.rows,
            clicks: clicks.rows,
            reviews: allReviews.rows // Ajouté pour l'admin
        });
    } catch (e) { res.status(500).json({error: e}); }
});

// --- TRACKING & PAIEMENT (Identique) ---
app.post('/api/track', async (req, res) => {
    const { type, page, source, device, target } = req.body;
    try { await pool.query('INSERT INTO analytics (type, page, source, device, target) VALUES ($1, $2, $3, $4, $5)', [type, page, source, device, target]); res.json({ success: true }); } catch (e) { res.json({ success: false }); }
});
app.post('/create-checkout-session', async (req, res) => { /* ... Code Stripe précédent conservé ... */ });
app.get('/success', async (req, res) => { /* ... Code Success précédent conservé ... */ });
app.get('/cancel', (req, res) => res.redirect('/'));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, '../index.html')); });
app.get('/admin-secret-dashboard', (req, res) => { res.sendFile(path.join(__dirname, '../admin.html')); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => { console.log(`🚀 Serveur prêt sur le port ${PORT}`); await initDB(); });