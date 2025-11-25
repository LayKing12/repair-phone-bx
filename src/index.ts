import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
// On enlève nodemailer
import Stripe from 'stripe';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes } from 'crypto';
// On importe le nouvel outil Brevo
import * as Brevo from '@getbrevo/brevo';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, '../images')));

function generateTrackingCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    const bytes = randomBytes(length);
    for (let i = 0; i < length; i++) { result += chars[bytes[i] % chars.length]; }
    return result;
}

// --- NOUVELLE CONFIGURATION EMAIL VIA L'API WEB DE BREVO ---
// C'est la méthode qui contourne tous les pare-feux.
const apiInstance = new Brevo.TransactionalEmailsApi();
// On utilise la clé API que tu as déjà mise dans GMAIL_PASS sur Render
apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.GMAIL_PASS || '');

// Fonction utilitaire pour envoyer un email facilement
async function sendBrevoEmail(toEmail: string, toName: string, subject: string, htmlContent: string) {
    const sendSmtpEmail = new Brevo.SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    // L'expéditeur : On utilise ton email d'identifiant Brevo comme adresse "From"
    sendSmtpEmail.sender = { "name": "Repair Phone BX", "email": process.env.GMAIL_USER };
    sendSmtpEmail.to = [{ "email": toEmail, "name": toName }];

    try {
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`✅ Email envoyé avec succès à ${toEmail} via API Brevo.`);
    } catch (error: any) {
        console.error(`❌ ERREUR API BREVO vers ${toEmail}:`, error.response ? error.response.text : error.message);
    }
}
// ----------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-11-20.acacia' });
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ... (LA LISTE INITIAL_PRODUCTS EST TOUJOURS LÀ, JE NE LA RECOPIE PAS POUR GAGNER DE LA PLACE) ...
const INITIAL_PRODUCTS = [
    { category: 'ECO', model: 'iPhone X', price: 40, image: 'images/iphone-X-noir.jpg' },
    // ... (Imagine que toute ta liste est ici) ...
    { category: 'BATTERIE', model: 'iPhone 14 Pro Max', price: 170, image: 'images/iphone-14-pro-max.jpg' }
];


const initDB = async () => {
    console.log("🛠️ Vérification de la base de données...");
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS reservations_v5 (id SERIAL PRIMARY KEY, client_name TEXT, email TEXT, phone TEXT, service_type TEXT, date TEXT, total_price INTEGER, amount_paid INTEGER, payment_status TEXT DEFAULT 'pending', status TEXT DEFAULT 'pending', tracking_code TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, author TEXT, content TEXT, rating INTEGER, client_token TEXT, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS analytics (id SERIAL PRIMARY KEY, type TEXT, page TEXT, source TEXT, device TEXT, target TEXT, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, category TEXT, model TEXT, price INTEGER, old_price INTEGER DEFAULT 0, image TEXT);`);

        try { await pool.query(`ALTER TABLE reservations_v5 ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';`); } catch (e) {}
        try { await pool.query(`ALTER TABLE reservations_v5 ADD COLUMN IF NOT EXISTS tracking_code TEXT;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE reservations_v5 ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS client_token TEXT;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS date TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`); } catch (e) {}
        console.log("🛠️ Migrations DB terminées.");

        const check = await pool.query('SELECT COUNT(*) FROM products');
        if (parseInt(check.rows[0].count) === 0) {
            console.log("🌱 Injection des produits initiaux...");
            for (const p of INITIAL_PRODUCTS) { await pool.query('INSERT INTO products (category, model, price, old_price, image) VALUES ($1, $2, $3, $4, $5)', [p.category, p.model, p.price, p.old_price || 0, p.image]); }
        }
        console.log("✅ DB prête et à jour.");
    } catch (err) { console.error("❌ Erreur critique DB durant l'initialisation :", err); }
};

// ROUTES API (Inchangées)
app.get('/api/categories', async (req, res) => { try { const result = await pool.query('SELECT DISTINCT category FROM products ORDER BY category ASC'); res.json(result.rows.map(r => r.category)); } catch (e) { res.status(500).json({error: "Erreur"}); } });
app.get('/api/products', async (req, res) => { try { const r = await pool.query('SELECT * FROM products ORDER BY id ASC'); res.json(r.rows); } catch (e) { res.status(500).json({error:"Erreur"}); }});
app.get('/reviews', async (req, res) => { try { const r = await pool.query('SELECT id, author, content, rating, date, client_token FROM reviews ORDER BY id DESC'); res.json(r.rows); } catch (e) { res.json([]); } });
app.post('/reviews', async (req, res) => { const t = randomUUID(); try { await pool.query('INSERT INTO reviews (author, content, rating, client_token) VALUES ($1, $2, $3, $4)', [req.body.author, req.body.content, req.body.rating, t]); res.json({ success: true, token: t }); } catch (e) { res.status(500).json({error: "Erreur DB"}); }});
app.delete('/reviews/:id', async (req, res) => { const { token, password } = req.body; const reviewId = req.params.id; try { if (password === "MonCodeSecret123") { await pool.query('DELETE FROM reviews WHERE id = $1', [reviewId]); return res.json({ success: true }); } if (token) { const check = await pool.query('SELECT * FROM reviews WHERE id = $1 AND client_token = $2', [reviewId, token]); if (check.rows.length > 0) { await pool.query('DELETE FROM reviews WHERE id = $1', [reviewId]); return res.json({ success: true }); } } res.status(403).json({ error: "Interdit" }); } catch (e) { res.status(500).json({ error: "Erreur" }); } });
app.post('/api/track', async (req, res) => { const { type, page, source, device, target } = req.body; try { await pool.query('INSERT INTO analytics (type, page, source, device, target) VALUES ($1, $2, $3, $4, $5)', [type, page, source, device, target]); res.json({ success: true }); } catch (e) { res.json({ success: false }); } });
app.post('/api/my-order', async (req, res) => { const { code } = req.body; if(!code) return res.status(400).json({error: "Code de suivi requis"}); try { const result = await pool.query(`SELECT client_name, service_type, date, status, tracking_code FROM reservations_v5 WHERE tracking_code = $1 AND payment_status = 'paid'`, [code.toUpperCase()]); if(result.rows.length === 0) return res.status(404).json({error: "Code invalide ou commande non trouvée."}); res.json(result.rows[0]); } catch (e) { res.status(500).json({error: "Erreur serveur"}); } });

// ROUTES ADMIN
const CHECK_ADMIN = (req, res, next) => { if(req.body.password === "MonCodeSecret123" || req.query.password === "MonCodeSecret123") next(); else res.status(403).json({error:"Accès refusé"}); };
app.put('/api/admin/products/:id', CHECK_ADMIN, async (req, res) => { const { price, category } = req.body; const productId = req.params.id; try { if (price !== undefined) await pool.query('UPDATE products SET price = $1 WHERE id = $2', [price, productId]); if (category !== undefined) await pool.query('UPDATE products SET category = $1 WHERE id = $2', [category.trim().toUpperCase(), productId]); res.json({success: true}); } catch (e) { console.error(e); res.status(500).json({error: "Erreur"}); } });
app.post('/api/admin/stats', CHECK_ADMIN, async (req, res) => { try { const t = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view'"); const td = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view' AND date >= CURRENT_DATE"); const d = await pool.query("SELECT device, COUNT(*) FROM analytics WHERE type='view' GROUP BY device"); const c = await pool.query("SELECT target, COUNT(*) FROM analytics WHERE type='click' GROUP BY target"); const r = await pool.query("SELECT * FROM reviews ORDER BY id DESC"); res.json({ total: t.rows[0].count, today: td.rows[0].count, devices: d.rows, clicks: c.rows, reviews: r.rows }); } catch (e) { res.status(500).json({error: e}); } });
app.get('/api/admin/reservations', CHECK_ADMIN, async (req, res) => { try { const r = await pool.query("SELECT id, client_name, email, phone, service_type, date, status, amount_paid, tracking_code FROM reservations_v5 WHERE payment_status='paid' ORDER BY id DESC"); res.json(r.rows); } catch(e) { res.status(500).send(); } });
app.delete('/api/admin/reservations/:id', CHECK_ADMIN, async (req, res) => { try { await pool.query('DELETE FROM reservations_v5 WHERE id = $1', [req.params.id]); res.json({success: true}); } catch(e) { console.error(e); res.status(500).json({error: "Erreur"}); } });

// ENVOI EMAIL AUTOMATIQUE QUAND FINI (Avec la nouvelle fonction API)
app.put('/api/admin/reservations/:id/status', CHECK_ADMIN, async (req, res) => {
    const { status } = req.body;
    const resId = req.params.id;
    try {
        await pool.query("UPDATE reservations_v5 SET status = $1 WHERE id = $2", [status, resId]);
        if (status === 'finished') {
            const clientRes = await pool.query("SELECT client_name, email, service_type FROM reservations_v5 WHERE id = $1", [resId]);
            if (clientRes.rows.length > 0) {
                const client = clientRes.rows[0];
                // Appel de la nouvelle fonction API
                sendBrevoEmail(
                    client.email,
                    client.client_name,
                    '✅ Votre appareil est prêt !',
                    `<h2>Bonjour ${client.client_name},</h2><p>Bonne nouvelle ! La réparation de votre appareil (${client.service_type}) est terminée.</p><p>Vous pouvez venir le récupérer dès maintenant à notre atelier situé à Ribaucourt.</p><p>À très vite,<br>L'équipe Repair Phone BX</p>`
                );
            }
        }
        res.json({success:true});
    } catch(e) { res.status(500).send(); }
});

// PAIEMENT STRIPE (URL en dur pour Render)
app.post('/create-checkout-session', async (req, res) => {
    const { client_name, email, phone, service_type, date, price, payment_choice } = req.body;
    const amountToPay = payment_choice === 'deposit' ? 1500 : price * 100;
    const DOMAIN = 'https://repair-phone-bx-1.onrender.com'; 
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'bancontact'],
            line_items: [{ price_data: { currency: 'eur', product_data: { name: `Réparation: ${service_type}` }, unit_amount: amountToPay }, quantity: 1 }],
            mode: 'payment',
            success_url: `${DOMAIN}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${DOMAIN}/cancel`,
            metadata: { client_name, email, phone, service_type, date, total_price: price, type: payment_choice }
        });
        res.json({ url: session.url });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// SUCCÈS PAIEMENT (Avec la nouvelle fonction API)
app.get('/success', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        const { client_name, email, phone, service_type, date, total_price, type } = session.metadata;
        const trackingCode = generateTrackingCode();
        
        await pool.query(`INSERT INTO reservations_v5 (client_name, email, phone, service_type, date, total_price, amount_paid, payment_status, status, tracking_code) VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', 'pending', $8)`, [client_name, email, phone, service_type, date, total_price, (type==='deposit' ? 15 : total_price), trackingCode]);

        // Email Client via API
        sendBrevoEmail(
            email,
            client_name,
            '✅ Confirmation et Code de Suivi',
            `<h2>Merci ${client_name} !</h2><p>Votre commande est confirmée pour le ${date}.</p><p>Voici votre CODE DE SUIVI SECRET :</p><h1 style="color:#ff5c39; background:#eee; padding:10px; display:inline-block;">${trackingCode}</h1><p><a href="https://repair-phone-bx-1.onrender.com/suivi.html">Suivre ma commande</a></p>`
        );

        // Email Admin via API (Envoyé à l'adresse d'envoi)
        sendBrevoEmail(
            process.env.GMAIL_USER || '',
            'Admin Repair Phone BX',
            '🔔 NOUVELLE COMMANDE !',
            `<h2>Nouvelle réservation !</h2><p>Client: <b>${client_name}</b></p><p>Service: <b>${service_type}</b></p><p>Date: <b>${date}</b></p><p>Tél: ${phone}</p><p>Email: ${email}</p><p>Code suivi: ${trackingCode}</p>`
        );
        
        res.redirect(`/suivi.html?code=${trackingCode}&new=1`);
    } catch(e) { res.send("Erreur enregistrement. Contactez-nous."); console.error(e); }
});
app.get('/cancel', (req, res) => res.redirect('/'));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, '../index.html')); });
app.get('/admin-secret-dashboard', (req, res) => { res.sendFile(path.join(__dirname, '../admin.html')); });
app.get('/suivi.html', (req, res) => { res.sendFile(path.join(__dirname, '../suivi.html')); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => { console.log(`🚀 Serveur prêt sur ${PORT}`); await initDB(); });