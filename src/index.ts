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

// On dit au code : "Prends la clé dans l'environnement sécurisé"
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
    apiVersion: '2024-11-20.acacia',
});

// GMAIL (Remets ton email et mot de passe d'application ici !)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'aliouking.14@gmail.com', 
        pass: process.env.EMAIL_PASS
    }
});

// BASE DE DONNÉES
const pool = new Pool({
    connectionString: 'postgres://user:password@localhost:5432/booking_db'
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

// --- ROUTE 1 : CRÉATION PAIEMENT (AUCUN MAIL ICI) ---
app.post('/create-checkout-session', async (req, res) => {
    const { client_name, email, phone, service_type, date, price } = req.body;
    
    // ⚠️ METS TON LIEN NGROK ICI
    const MY_DOMAIN = 'https://charla-unenlightening-elliptically.ngrok-free.dev'; 

    if (!client_name || !email || !phone || !date || !price) {
        return res.status(400).json({ error: "Infos manquantes" });
    }

    const ACOMPTE = 15;
    const RESTE = price - ACOMPTE;

    try {
        // 1. On insère en DB (Statut: NON PAYÉ)
        const dbResult = await pool.query(
            'INSERT INTO reservations_v4 (client_name, email, phone, service_type, date, total_price, deposit_paid) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [client_name, email, phone, service_type, date, price, false]
        );
        const reservationId = dbResult.rows[0].id;

        // 2. Création session Stripe avec METADATA (Infos cachées pour plus tard)
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: `Acompte : ${service_type}`,
                        description: `Client: ${client_name} | Reste à payer: ${RESTE}€`,
                    },
                    unit_amount: ACOMPTE * 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            // On passe l'ID pour retrouver la réservation au retour
            metadata: {
                reservation_id: reservationId,
                client_name: client_name,
                phone: phone,
                service_type: service_type,
                date: date,
                reste: RESTE
            },
            success_url: `${MY_DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${MY_DOMAIN}/cancel`,
        });

        console.log(`⏳ Session créée pour ${client_name} (En attente de paiement...)`);
        res.json({ url: session.url });

    } catch (e) {
        console.error("ERREUR :", e);
        res.status(500).json({ error: "Erreur Serveur" });
    }
});

// --- ROUTE 2 : SUCCÈS DU PAIEMENT (ENVOI MAIL ICI) ---
app.get('/success', async (req, res) => {
    const sessionId = req.query.session_id as string;

    try {
        // 1. Vérification auprès de Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            
            // On récupère les infos
            const data = session.metadata; 
            const clientEmail = session.customer_details?.email || "Inconnu";

            if(data) {
                // 2. Mise à jour DB (Payé = VRAI)
                await pool.query('UPDATE reservations_v4 SET deposit_paid = TRUE WHERE id = $1', [data.reservation_id]);

                // 3. ENVOI DES EMAILS (C'est le seul endroit où ça part !)
                console.log("💰 Paiement validé ! Envoi des emails...");

                const mailToBoss = {
                    from: 'Repair Phone BX',
                    to: 'aliouking.14@gmail.com',
                    subject: `✅ PAIEMENT REÇU : RDV ${data.client_name}`,
                    text: `Nouveau RDV Confirmé !\n\n👤 Client : ${data.client_name}\n📞 Tél : ${data.phone}\n📧 Email : ${clientEmail}\n📱 Service : ${data.service_type}\n📅 Date : ${data.date}\n\n💰 Acompte de 15€ encaissé.`
                };

                const mailToClient = {
                    from: 'Repair Phone BX',
                    to: clientEmail,
                    subject: `Confirmation RDV - Repair Phone BX`,
                    text: `Bonjour ${data.client_name},\n\nVotre rendez-vous est confirmé.\n\n📅 Date : ${data.date}\n📱 Service : ${data.service_type}\n📍 Adresse : Ribaucourt (Molenbeek)\n\n✅ Acompte de 15€ réglé.\n💰 Reste à payer sur place : ${data.reste}€\n\nÀ bientôt !`
                };

                transporter.sendMail(mailToBoss).catch(console.error);
                transporter.sendMail(mailToClient).catch(console.error);
            }
        }
    } catch (err) {
        console.error("Erreur vérification Stripe:", err);
    }

    // Page HTML de succès
    res.send(`
        <html>
            <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
            <body style="font-family:sans-serif; text-align:center; padding:50px; background-color:#e8f5e9;">
                <h1 style="color:#2ecc71;">✅ Paiement Validé !</h1>
                <p>Votre RDV est confirmé.</p>
                <p>Un email de confirmation vient de vous être envoyé.</p>
                <br>
                <a href="/" style="background:#333; color:white; padding:15px 30px; text-decoration:none; border-radius:5px; font-weight:bold;">Retour au site</a>
            </body>
        </html>
    `);
});

app.get('/cancel', (req, res) => { res.send("<h1>❌ Annulé</h1><p>Aucun paiement n'a été débité.</p><a href='/'>Retour</a>"); });

// --- ROUTES AVIS ---
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