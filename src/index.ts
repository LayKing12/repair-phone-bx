import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, '../images')));

// CONFIGURATION
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-11-20.acacia' });
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'aliouking.14@gmail.com', pass: process.env.EMAIL_PASS }
});
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- 1. INIT DB (Avec la nouvelle table ANALYTICS) ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reservations_v5 (
                id SERIAL PRIMARY KEY, client_name TEXT, email TEXT, phone TEXT, 
                service_type TEXT, date TEXT, total_price INTEGER, amount_paid INTEGER,
                payment_status TEXT DEFAULT 'pending'
            );
        `);
        await pool.query(`CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, author TEXT, content TEXT, rating INTEGER);`);
        
        // TABLE ANALYTICS PUISSANTE
        await pool.query(`
            CREATE TABLE IF NOT EXISTS analytics (
                id SERIAL PRIMARY KEY,
                type TEXT, -- 'view' ou 'click'
                page TEXT,
                source TEXT, -- 'direct', 'google', 'qr', etc.
                device TEXT, -- 'mobile', 'desktop'
                target TEXT, -- Pour les clics (ex: 'whatsapp', 'booking')
                date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Base de données prête !");
    } catch (err) { console.error("❌ Erreur DB", err); }
};

// --- 2. ROUTES TRACKING (Pour enregistrer les visites) ---
app.post('/api/track', async (req, res) => {
    const { type, page, source, device, target } = req.body;
    try {
        await pool.query(
            'INSERT INTO analytics (type, page, source, device, target) VALUES ($1, $2, $3, $4, $5)',
            [type, page, source, device, target]
        );
        res.json({ success: true });
    } catch (e) { console.error(e); res.json({ success: false }); }
});

// --- 3. ROUTES ADMIN STATS (Sécurisé par mot de passe JS côté client) ---
app.post('/api/admin/stats', async (req, res) => {
    const { password } = req.body;
    if(password !== "MonCodeSecret123") return res.status(403).json({error: "Accès refusé"}); // CHANGE CE MOT DE PASSE !

    try {
        const totalVisits = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view'");
        const todayVisits = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view' AND date >= CURRENT_DATE");
        
        // Visites 7 jours (pour le graphique)
        const last7Days = await pool.query(`
            SELECT to_char(date, 'Dy') as day, COUNT(*) as count 
            FROM analytics WHERE type='view' AND date > current_date - interval '7 days' 
            GROUP BY day ORDER BY MIN(date)
        `);

        // Appareils
        const devices = await pool.query("SELECT device, COUNT(*) FROM analytics WHERE type='view' GROUP BY device");
        
        // Clics importants
        const clicks = await pool.query("SELECT target, COUNT(*) FROM analytics WHERE type='click' GROUP BY target");

        res.json({
            total: totalVisits.rows[0].count,
            today: todayVisits.rows[0].count,
            chart: last7Days.rows,
            devices: devices.rows,
            clicks: clicks.rows
        });
    } catch (e) { res.status(500).json({error: e}); }
});

// --- ROUTES PAGES ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, '../index.html')); });

// URL SECRÈTE ADMIN
app.get('/admin-secret-dashboard', (req, res) => { res.sendFile(path.join(__dirname, '../admin.html')); });

// ... (Garde tes routes existantes PAIEMENT, SUCCESS, AVIS ci-dessous, ne les efface pas) ...
// (Je les raccourcis ici pour la lisibilité, mais garde ton code de paiement Stripe complet)
app.post('/create-checkout-session', async (req, res) => { /* ... ton code Stripe ... */ });
app.get('/success', (req, res) => { /* ... ton code Success ... */ });
app.get('/cancel', (req, res) => { /* ... ton code Cancel ... */ });
app.get('/reviews', async (req, res) => { /* ... */ }); 
app.post('/reviews', async (req, res) => { /* ... */ });
app.delete('/reviews/:id', async (req, res) => { /* ... */ });
app.put('/reviews/:id', async (req, res) => { /* ... */ });


const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`🚀 Serveur prêt sur le port ${PORT}`);
    await initDB(); 
});