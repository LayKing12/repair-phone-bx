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

// Autoriser les images
app.use('/images', express.static(path.join(__dirname, '../images')));

// --- 1. CONFIGURATION ---

// CLÉ STRIPE (Récupérée depuis les variables Render)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-11-20.acacia',
});

// GMAIL
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'aliouking.14@gmail.com', 
        pass: process.env.EMAIL_PASS || 'sdhh wnvp imvs jobn'
    }
});

// BASE DE DONNÉES
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/booking_db',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// SERVIR LE SITE
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, '../index.html')); });

// INIT DB
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reservations_v4 (
                id SERIAL PRIMARY KEY,
                client_name TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL,
                service_type TEXT NOT NULL,
                date TEXT NOT NULL,
                total_price INTEGER,
                deposit_paid BOOLEAN DEFAULT FALSE
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reviews (
                id SERIAL PRIMARY KEY,
                author TEXT,
                content TEXT,
                rating INTEGER
            );
        `);
        console.log("✅ Base de données prête !");
    } catch (err) { console.error("❌ Erreur DB", err); }
};

// --- ROUTE PAIEMENT STRIPE ---
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { client_name, email, phone, service_type, date, price } = req.body;
        
        // URL DU SITE SUR RENDER (Dynamique ou fixe)
        const SITE_URL = 'https://repair-phone-bx-1.onrender.com'; 

        // Validation
        if (!client_name || !email || !phone || !date || !price) {
            throw new Error("Informations manquantes (Nom, Email, Tél ou Date)");
        }

        const ACOMPTE = 15;
        const RESTE = price - ACOMPTE;

        // 1. Création session Stripe
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: `Acompte : ${service_type}`,
                        description: `Client: ${client_name} (${phone}) | Total: ${price}€ | Reste à payer: ${RESTE}€`,
                    },
                    unit_amount: ACOMPTE * 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${SITE_URL}/cancel`,
        });

        // 2. Sauvegarde DB
        await pool.query(
            'INSERT INTO reservations_v4 (client_name, email, phone, service_type, date, total_price, deposit_paid) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [client_name, email, phone, service_type, date, price, false]
        );

        // 3. Préparation Emails (Envoyés plus tard au succès, ou ici pour débug)
        // (Pour simplifier et être sûr que tu reçois, on envoie l'alerte "Tentative" ici)
        const mailToBoss = {
            from: 'Repair Phone BX',
            to: 'aliouking.14@gmail.com',
            subject: `⏳ Tentative de réservation : ${client_name}`,
            text: `Le client est sur la page de paiement.\nClient: ${client_name}\nService: ${service_type}`
        };
        transporter.sendMail(mailToBoss).catch(console.error);

        res.json({ url: session.url });

    } catch (error: any) {
        // ✅ GESTION D'ERREUR AMÉLIORÉE (Comme tu as demandé)
        console.error("🔴 ERREUR SERVEUR / STRIPE :", error.message);
        res.status(500).json({ error: error.message || "Erreur interne du serveur" });
    }
});

app.get('/success', (req, res) => { res.send(`<html><body style="font-family:sans-serif; text-align:center; padding:50px; background-color:#e8f5e9;"><h1 style="color:#2ecc71;">✅ Paiement Validé !</h1><p>RDV Confirmé.</p><a href="/">Retour au site</a></body></html>`); });
app.get('/cancel', (req, res) => { res.send("<h1>❌ Annulé</h1><a href='/'>Retour</a>"); });

// Routes API
app.get('/reviews', async (req, res) => { try { const result = await pool.query('SELECT * FROM reviews ORDER BY id DESC'); res.json(result.rows); } catch (e) { res.json([]); } });
app.post('/reviews', async (req, res) => { const { author, content, rating } = req.body; try { const r = await pool.query('INSERT INTO reviews (author, content, rating) VALUES ($1, $2, $3) RETURNING id', [author, content, rating]); res.json({ success: true, id: r.rows[0].id }); } catch (e) { res.status(500).json(e); } });
app.delete('/reviews/:id', async (req, res) => { try { await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json(e); } });
app.put('/reviews/:id', async (req, res) => { const { content, rating } = req.body; try { await pool.query('UPDATE reviews SET content=$1, rating=$2 WHERE id=$3', [content, rating, req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json(e); } });

// Admin Panel
app.get('/admin-secret-panel', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM reviews ORDER BY id DESC');
        let html = `<html><head><title>Admin</title><style>body{font-family:sans-serif;padding:20px;}.review{border:1px solid #ddd;padding:10px;margin-bottom:10px;display:flex;justify-content:space-between;}.btn{background:red;color:white;border:none;padding:5px 10px;cursor:pointer;}</style></head><body><h1>Admin Avis</h1><a href='/'>Retour</a><br><br>`;
        result.rows.forEach(r => { html += `<div class="review"><div><b>${r.author}</b>: ${r.content}</div><button class="btn" onclick="del(${r.id})">Suppr</button></div>`; });
        html += `<script>function del(id){if(confirm('Supprimer ?')) fetch('/reviews/'+id,{method:'DELETE'}).then(()=>location.reload());}</script></body></html>`;
        res.send(html);
    } catch (e) { res.send(e); }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`🚀 Serveur prêt sur le port ${PORT}`);
    await initDB(); 
});