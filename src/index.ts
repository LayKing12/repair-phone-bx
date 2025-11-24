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

// --- CONFIGURATION ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-11-20.acacia' });

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'aliouking.14@gmail.com', 
        pass: process.env.EMAIL_PASS
    }
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, '../index.html')); });

// INIT DB
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
        console.log("✅ Base de données prête !");
    } catch (err) { console.error("❌ Erreur DB", err); }
};

// --- ROUTE PAIEMENT ---
app.post('/create-checkout-session', async (req, res) => {
    const { client_name, email, phone, service_type, date, price, payment_choice } = req.body;
    
    const MY_DOMAIN = 'https://repair-phone-bx-1.onrender.com'; 

    if (!client_name || !email || !phone || !date || !price) {
        return res.status(400).json({ error: "Infos manquantes" });
    }

    // LOGIQUE DE PAIEMENT
    let amountToPay = 0;
    let description = "";
    let reste = 0;

    if (payment_choice === 'full') {
        amountToPay = price;
        reste = 0;
        description = `Paiement TOTAL pour : ${service_type}. Reste à payer : 0€`;
    } else {
        amountToPay = 15; // Acompte
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
                    product_data: {
                        name: `Réservation : ${service_type}`,
                        description: description,
                    },
                    unit_amount: Math.round(amountToPay * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            metadata: {
                client_name, phone, service_type, date, 
                total_price: price,
                amount_paid: amountToPay,
                reste: reste
            },
            success_url: `${MY_DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${MY_DOMAIN}/cancel`,
        });

        // Sauvegarde temporaire
        await pool.query(
            'INSERT INTO reservations_v5 (client_name, email, phone, service_type, date, total_price, amount_paid, payment_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [client_name, email, phone, service_type, date, price, amountToPay, 'pending']
        );

        res.json({ url: session.url });

    } catch (e: any) {
        console.error("ERREUR :", e.message);
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
                // Update DB (On ne cherche pas par ID ici pour simplifier, on insert juste confirmation ou on log)
                // Pour simplifier la version V5, on considère que si le mail part, c'est bon.
                
                const textPaiement = data.reste == '0' ? "✅ TOTALITÉ RÉGLÉE EN LIGNE" : `✅ Acompte de 15€ réglé. Reste à payer : ${data.reste}€ (Espèces/Carte)`;

                // Mail Client
                const mailToClient = {
                    from: 'Repair Phone BX',
                    to: session.customer_details?.email || '',
                    subject: `Confirmation RDV - Repair Phone BX`,
                    text: `Bonjour ${data.client_name},\n\nVotre rendez-vous est validé !\n\n📅 Date : ${data.date}\n📱 Service : ${data.service_type}\n📍 Adresse : Ribaucourt, 1080 Molenbeek\n\n${textPaiement}\n\nÀ bientôt !`
                };

                // Mail Boss
                const mailToBoss = {
                    from: 'Repair Phone BX',
                    to: 'aliouking.14@gmail.com',
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

// AVIS
app.get('/reviews', async (req, res) => { try { const r = await pool.query('SELECT * FROM reviews ORDER BY id DESC'); res.json(r.rows); } catch (e) { res.json([]); } });
app.post('/reviews', async (req, res) => { const { author, content, rating } = req.body; try { const r = await pool.query('INSERT INTO reviews (author, content, rating) VALUES ($1, $2, $3) RETURNING id', [author, content, rating]); res.json({ success: true, id: r.rows[0].id }); } catch (e) { res.status(500).json(e); } });
app.delete('/reviews/:id', async (req, res) => { try { await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json(e); } });
app.put('/reviews/:id', async (req, res) => { const { content, rating } = req.body; try { await pool.query('UPDATE reviews SET content=$1, rating=$2 WHERE id=$3', [content, rating, req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json(e); } });
app.get('/admin-secret-panel', async (req, res) => {
    const r = await pool.query('SELECT * FROM reviews ORDER BY id DESC');
    let html = `<h1>Admin</h1><a href='/'>Retour</a><hr>`;
    r.rows.forEach(rw => { html += `<div><b>${rw.author}</b>: ${rw.content} <button onclick="fetch('/reviews/${rw.id}',{method:'DELETE'}).then(()=>location.reload())" style="color:red">Suppr</button></div><hr>`; });
    res.send(html);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => { console.log(`🚀 Serveur prêt ${PORT}`); await initDB(); });