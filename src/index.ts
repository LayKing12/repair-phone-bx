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

// CLÉ STRIPE
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-11-20.acacia',
});

// GMAIL
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'aliouking.14@gmail.com', 
        pass: process.env.EMAIL_PASS
    }
});

// BASE DE DONNÉES
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- INIT DB (Avec la nouvelle table TRAFIC) ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reservations_v5 (
                id SERIAL PRIMARY KEY,
                client_name TEXT, email TEXT, phone TEXT, 
                service_type TEXT, date TEXT, 
                total_price INTEGER, amount_paid INTEGER,
                payment_status TEXT DEFAULT 'pending'
            );
        `);
        await pool.query(`CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, author TEXT, content TEXT, rating INTEGER);`);
        // NOUVELLE TABLE POUR LES VISITES 👇
        await pool.query(`CREATE TABLE IF NOT EXISTS site_traffic (id SERIAL PRIMARY KEY, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        console.log("✅ Base de données prête !");
    } catch (err) { console.error("❌ Erreur DB", err); }
};

// --- ROUTE D'ACCUEIL (COMPTE LES VISITES) ---
app.get('/', async (req, res) => {
    // À chaque chargement de la page, on ajoute +1 en base de données
    try {
        await pool.query('INSERT INTO site_traffic DEFAULT VALUES');
    } catch(e) { console.error("Erreur comptage visite:", e); }
    
    res.sendFile(path.join(__dirname, '../index.html')); 
});

// --- ROUTE PAIEMENT ---
app.post('/create-checkout-session', async (req, res) => {
    const { client_name, email, phone, service_type, date, price, payment_choice } = req.body;
    const MY_DOMAIN = 'https://repair-phone-bx-1.onrender.com'; 

    if (!client_name || !email || !phone || !date || !price) return res.status(400).json({ error: "Infos manquantes" });

    let amountToPay = 0;
    let description = "";
    let reste = 0;

    if (payment_choice === 'full') {
        amountToPay = price;
        reste = 0;
        description = `Paiement TOTAL pour : ${service_type}. Reste à payer : 0€`;
    } else {
        amountToPay = 15;
        reste = price - 15;
        description = `Acompte pour : ${service_type}. Reste à payer sur place : ${reste}€`;
    }

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { name: `Réservation : ${service_type}`, description: description },
                    unit_amount: Math.round(amountToPay * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            metadata: { client_name, phone, service_type, date, total_price: price, amount_paid: amountToPay, reste: reste },
            success_url: `${MY_DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${MY_DOMAIN}/cancel`,
        });

        await pool.query(
            'INSERT INTO reservations_v5 (client_name, email, phone, service_type, date, total_price, amount_paid, payment_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [client_name, email, phone, service_type, date, price, amountToPay, 'pending']
        );

        res.json({ url: session.url });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// --- SUCCÈS ---
app.get('/success', async (req, res) => {
    const sessionId = req.query.session_id as string;
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status === 'paid') {
            const data = session.metadata;
            if(data) {
                const textPaiement = data.reste == '0' ? "✅ TOTALITÉ RÉGLÉE EN LIGNE" : `✅ Acompte de 15€ réglé. Reste à payer : ${data.reste}€ (Espèces/Carte)`;
                
                const mailToClient = {
                    from: 'Repair Phone BX', to: session.customer_details?.email || '',
                    subject: `Confirmation RDV - Repair Phone BX`,
                    text: `Bonjour ${data.client_name},\n\nVotre rendez-vous est validé !\n\n📅 Date : ${data.date}\n📱 Service : ${data.service_type}\n📍 Adresse : Ribaucourt, 1080 Molenbeek\n\n${textPaiement}\n\nÀ bientôt !`
                };
                const mailToBoss = {
                    from: 'Repair Phone BX', to: 'aliouking.14@gmail.com',
                    subject: `🔔 NOUVEAU RDV PAYÉ : ${data.client_name}`,
                    text: `Client : ${data.client_name}\nTél : ${data.phone}\nService : ${data.service_type}\nDate : ${data.date}\n\n💰 Montant reçu : ${data.amount_paid}€\n💰 Reste à encaisser : ${data.reste}€`
                };
                transporter.sendMail(mailToClient).catch(console.error);
                transporter.sendMail(mailToBoss).catch(console.error);
            }
        }
    } catch (err) { console.error(err); }
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#e8f5e9;"><h1 style="color:#2ecc71;">✅ Paiement Validé !</h1><p>RDV Confirmé. Regardez vos emails.</p><a href="/">Retour</a></body></html>`);
});

app.get('/cancel', (req, res) => { res.send("<h1>❌ Annulé</h1><a href='/'>Retour</a>"); });

// --- AVIS ---
app.get('/reviews', async (req, res) => { try { const r = await pool.query('SELECT * FROM reviews ORDER BY id DESC'); res.json(r.rows); } catch (e) { res.json([]); } });
app.post('/reviews', async (req, res) => { const { author, content, rating } = req.body; try { const r = await pool.query('INSERT INTO reviews (author, content, rating) VALUES ($1, $2, $3) RETURNING id', [author, content, rating]); res.json({ success: true, id: r.rows[0].id }); } catch (e) { res.status(500).json(e); } });
app.delete('/reviews/:id', async (req, res) => { try { await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json(e); } });
app.put('/reviews/:id', async (req, res) => { const { content, rating } = req.body; try { await pool.query('UPDATE reviews SET content=$1, rating=$2 WHERE id=$3', [content, rating, req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json(e); } });

// --- PANEL ADMIN (AVEC STATS DE VISITES) ---
app.get('/admin-secret-panel', async (req, res) => {
    try {
        // 1. Récupérer les avis
        const reviews = await pool.query('SELECT * FROM reviews ORDER BY id DESC');
        
        // 2. Récupérer le trafic (Total et Aujourd'hui)
        const totalVisits = await pool.query('SELECT COUNT(*) FROM site_traffic');
        const todayVisits = await pool.query("SELECT COUNT(*) FROM site_traffic WHERE date >= CURRENT_DATE");

        let html = `
        <html>
            <head>
                <title>Admin RepairPhone</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; background: #f4f4f4; }
                    .stats-box { background: white; padding: 20px; border-radius: 12px; display: flex; gap: 20px; margin-bottom: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .stat { flex: 1; text-align: center; }
                    .stat h2 { margin: 0; font-size: 36px; color: #ff5c39; }
                    .stat p { margin: 5px 0 0 0; color: #666; font-size: 14px; font-weight: bold; }
                    
                    .review { background: white; padding: 15px; margin-bottom: 10px; border-radius: 8px; border-left: 5px solid #ff5c39; display: flex; justify-content: space-between; align-items: center; }
                    .btn-delete { background: red; color: white; border: none; padding: 8px 12px; cursor: pointer; border-radius: 4px; font-weight: bold; margin-left: 10px;}
                </style>
            </head>
            <body>
                <h1>📊 Tableau de Bord</h1>
                <a href="/" style="color:#666; text-decoration:none;">← Retour au site</a>
                <br><br>

                <div class="stats-box">
                    <div class="stat">
                        <h2>${totalVisits.rows[0].count}</h2>
                        <p>Visites Totales</p>
                    </div>
                    <div class="stat" style="border-left: 1px solid #eee;">
                        <h2>${todayVisits.rows[0].count}</h2>
                        <p>Visites Aujourd'hui</p>
                    </div>
                </div>

                <h2>👮‍♂️ Modération des Avis</h2>
                <hr style="border:0; border-top:1px solid #ddd; margin-bottom:20px;">
        `;
        
        reviews.rows.forEach(r => {
            html += `
            <div class="review" id="review-${r.id}">
                <div><strong>${r.author}</strong> (${r.rating}⭐)<br><em>"${r.content}"</em></div>
                <button class="btn-delete" onclick="del(${r.id})">SUPPRIMER</button>
            </div>`;
        });

        html += `
            <script>
                async function del(id) {
                    if(!confirm("Supprimer cet avis ?")) return;
                    await fetch('/reviews/' + id, { method: 'DELETE' });
                    document.getElementById('review-' + id).remove();
                }
            </script>
            </body></html>`;
        
        res.send(html);
    } catch (e) { res.send("Erreur Admin: " + e); }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`🚀 Serveur prêt sur le port ${PORT}`);
    await initDB(); 
});