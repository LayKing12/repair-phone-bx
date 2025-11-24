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
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- DONNÉES INITIALES (POUR REMPLIR LA BDD LA PREMIÈRE FOIS) ---
const INITIAL_PRODUCTS = [
    // ECO
    { category: 'ECO', model: 'iPhone X', price: 40, image: 'images/iphone-X-noir.jpg' },
    { category: 'ECO', model: 'iPhone XS', price: 40, image: 'images/iphone-XS-.jpg' },
    { category: 'ECO', model: 'iPhone XR', price: 45, image: 'images/apple-iphone-XR-.jpg' },
    { category: 'ECO', model: 'iPhone XS Max', price: 45, image: 'images/apple-iphone-XSmax.jpg' },
    { category: 'ECO', model: 'iPhone 11', price: 50, image: 'images/apple-iphone-11.jpg' },
    { category: 'ECO', model: 'iPhone 11 Pro', price: 50, image: 'images/apple-iphone-11Pro.jpg' },
    // PROMO (Prix spécial 50€ fixé, on stocke le "vieux prix" pour l'affichage)
    { category: 'PROMO', model: 'iPhone 11 Pro Max', price: 50, old_price: 60, image: 'images/iphone-11ProMax.jpg' },
    { category: 'PROMO', model: 'iPhone 12', price: 50, old_price: 70, image: 'images/apple-iphone-12.jpg' },
    { category: 'PROMO', model: 'iPhone 12 Mini', price: 50, old_price: 70, image: 'images/apple-iphone-12-mini.jpg' },
    { category: 'PROMO', model: 'iPhone 12 Pro', price: 50, old_price: 75, image: 'images/apple-iphone-12Pro.jpg' },
    { category: 'PROMO', model: 'iPhone 12 Pro Max', price: 50, old_price: 85, image: 'images/iphone-12ProMax.jpg' },
    { category: 'PROMO', model: 'iPhone 13', price: 50, old_price: 80, image: 'images/apple-iphone-13.jpg' },
    { category: 'PROMO', model: 'iPhone 13 Mini', price: 50, old_price: 75, image: 'images/apple-iphone-13-mini.jpg' },
    { category: 'PROMO', model: 'iPhone 13 Pro', price: 50, old_price: 155, image: 'images/apple-iphone-13Pro.jpg' },
    { category: 'PROMO', model: 'iPhone 14', price: 50, old_price: 80, image: 'images/apple-iphone-14.jpg' },
    { category: 'PROMO', model: 'iPhone 14 Plus', price: 50, old_price: 90, image: 'images/apple-iphone-14-Plus.jpg' },
    { category: 'PROMO', model: 'iPhone 14 Pro', price: 50, old_price: 155, image: 'images/apple-iphone-14Pro.jpg' },
    // NORMAL
    { category: 'NORMAL', model: 'iPhone 13 Pro Max', price: 180, image: 'images/iphone-13ProMax.jpg' },
    { category: 'NORMAL', model: 'iPhone 14 Pro Max', price: 180, image: 'images/iphone-14-pro-max.jpg' },
    // OLED
    { category: 'OLED', model: 'iPhone 15', price: 75, image: 'images/iphone-15.jpg' },
    { category: 'OLED', model: 'iPhone 15 Plus', price: 75, image: 'images/iphone-15Plus.jpg' },
    { category: 'OLED', model: 'iPhone 15 Pro', price: 85, image: 'images/iphone-15Pro.jpg' },
    { category: 'OLED', model: 'iPhone 15 Pro Max', price: 150, image: 'images/iphone-15ProMax.jpg' },
    { category: 'OLED', model: 'iPhone 16', price: 100, image: 'images/iphone-16.jpg' },
    { category: 'OLED', model: 'iPhone 16 Plus', price: 150, image: 'images/iphone-16Plus.jpg' },
    { category: 'OLED', model: 'iPhone 16 E', price: 150, image: 'images/iphone-16E.jpg' },
    { category: 'OLED', model: 'iPhone 16 Pro', price: 150, image: 'images/iphone-16Pro.jpg' },
    { category: 'OLED', model: 'iPhone 16 Pro Max', price: 200, image: 'images/iphone-16ProMax.jpg' },
    // BATTERIES
    { category: 'BATTERIE', model: 'iPhone X', price: 40, image: 'images/iphone-X-noir.jpg' },
    { category: 'BATTERIE', model: 'iPhone XS', price: 40, image: 'images/iphone-XS-.jpg' },
    { category: 'BATTERIE', model: 'iPhone XR', price: 45, image: 'images/apple-iphone-XR-.jpg' },
    { category: 'BATTERIE', model: 'iPhone XS Max', price: 45, image: 'images/apple-iphone-XSmax.jpg' },
    { category: 'BATTERIE', model: 'iPhone 11', price: 45, image: 'images/apple-iphone-11.jpg' },
    { category: 'BATTERIE', model: 'iPhone 11 Pro', price: 45, image: 'images/apple-iphone-11Pro.jpg' },
    { category: 'BATTERIE', model: 'iPhone 11 Pro Max', price: 55, image: 'images/iphone-11ProMax.jpg' },
    { category: 'BATTERIE', model: 'iPhone 12', price: 60, image: 'images/apple-iphone-12.jpg' },
    { category: 'BATTERIE', model: 'iPhone 12 Mini', price: 70, image: 'images/apple-iphone-12-mini.jpg' },
    { category: 'BATTERIE', model: 'iPhone 12 Pro', price: 60, image: 'images/apple-iphone-12Pro.jpg' },
    { category: 'BATTERIE', model: 'iPhone 12 Pro Max', price: 80, image: 'images/iphone-12ProMax.jpg' },
    { category: 'BATTERIE', model: 'iPhone 13', price: 80, image: 'images/apple-iphone-13.jpg' },
    { category: 'BATTERIE', model: 'iPhone 13 Mini', price: 80, image: 'images/apple-iphone-13-mini.jpg' },
    { category: 'BATTERIE', model: 'iPhone 13 Pro', price: 150, image: 'images/apple-iphone-13Pro.jpg' },
    { category: 'BATTERIE', model: 'iPhone 13 Pro Max', price: 170, image: 'images/iphone-13ProMax.jpg' },
    { category: 'BATTERIE', model: 'iPhone 14', price: 80, image: 'images/apple-iphone-14.jpg' },
    { category: 'BATTERIE', model: 'iPhone 14 Plus', price: 90, image: 'images/apple-iphone-14-Plus.jpg' },
    { category: 'BATTERIE', model: 'iPhone 14 Pro', price: 150, image: 'images/apple-iphone-14Pro.jpg' },
    { category: 'BATTERIE', model: 'iPhone 14 Pro Max', price: 170, image: 'images/iphone-14-pro-max.jpg' }
];

// --- INIT DB ---
const initDB = async () => {
    try {
        // Tables existantes
        await pool.query(`CREATE TABLE IF NOT EXISTS reservations_v5 (id SERIAL PRIMARY KEY, client_name TEXT, email TEXT, phone TEXT, service_type TEXT, date TEXT, total_price INTEGER, amount_paid INTEGER, payment_status TEXT DEFAULT 'pending');`);
        await pool.query(`CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, author TEXT, content TEXT, rating INTEGER);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS analytics (id SERIAL PRIMARY KEY, type TEXT, page TEXT, source TEXT, device TEXT, target TEXT, date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        // NOUVELLE TABLE PRODUITS
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY, 
                category TEXT, 
                model TEXT, 
                price INTEGER, 
                old_price INTEGER DEFAULT 0, 
                image TEXT
            );
        `);

        // SEEDING (Remplissage initial si vide)
        const check = await pool.query('SELECT COUNT(*) FROM products');
        if (parseInt(check.rows[0].count) === 0) {
            console.log("🌱 Base vide, insertion des produits...");
            for (const p of INITIAL_PRODUCTS) {
                await pool.query(
                    'INSERT INTO products (category, model, price, old_price, image) VALUES ($1, $2, $3, $4, $5)',
                    [p.category, p.model, p.price, p.old_price || 0, p.image]
                );
            }
            console.log("✅ Produits insérés !");
        }

        console.log("✅ Base de données prête !");
    } catch (err) { console.error("❌ Erreur DB", err); }
};

// --- ROUTES API PRODUITS ---
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({error: "Erreur chargement produits"}); }
});

// Route Admin pour modifier un prix
app.put('/api/admin/products/:id', async (req, res) => {
    const { password, price } = req.body;
    if(password !== "MonCodeSecret123") return res.status(403).json({error: "Accès refusé"});
    
    try {
        await pool.query('UPDATE products SET price = $1 WHERE id = $2', [price, req.params.id]);
        res.json({success: true});
    } catch (e) { res.status(500).json({error: "Erreur update"}); }
});

// --- ROUTES ADMIN STATS ---
app.post('/api/admin/stats', async (req, res) => {
    const { password } = req.body;
    if(password !== "MonCodeSecret123") return res.status(403).json({error: "Accès refusé"});

    try {
        const totalVisits = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view'");
        const todayVisits = await pool.query("SELECT COUNT(*) FROM analytics WHERE type='view' AND date >= CURRENT_DATE");
        const last7Days = await pool.query(`SELECT to_char(date, 'Dy') as day, COUNT(*) as count FROM analytics WHERE type='view' AND date > current_date - interval '7 days' GROUP BY day ORDER BY MIN(date)`);
        const devices = await pool.query("SELECT device, COUNT(*) FROM analytics WHERE type='view' GROUP BY device");
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

// --- TRACKING ---
app.post('/api/track', async (req, res) => {
    const { type, page, source, device, target } = req.body;
    try { await pool.query('INSERT INTO analytics (type, page, source, device, target) VALUES ($1, $2, $3, $4, $5)', [type, page, source, device, target]); res.json({ success: true }); } 
    catch (e) { res.json({ success: false }); }
});

// --- PAIEMENT STRIPE ---
app.post('/create-checkout-session', async (req, res) => {
    const { client_name, email, phone, service_type, date, price, payment_choice } = req.body;
    const amountToPay = payment_choice === 'deposit' ? 1500 : price * 100; // 15€ ou Total

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'bancontact'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { name: `Réparation: ${service_type} (${payment_choice === 'deposit' ? 'Acompte' : 'Total'})` },
                    unit_amount: amountToPay,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.API_URL || 'https://repair-phone-bx-1.onrender.com'}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.API_URL || 'https://repair-phone-bx-1.onrender.com'}/cancel`,
            metadata: { client_name, email, phone, service_type, date, total_price: price, type: payment_choice }
        });
        res.json({ url: session.url });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- SUCCESS PAGE ---
app.get('/success', async (req, res) => {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    const { client_name, email, phone, service_type, date, total_price, type } = session.metadata;
    
    // Sauvegarde en DB
    await pool.query(
        `INSERT INTO reservations_v5 (client_name, email, phone, service_type, date, total_price, amount_paid, payment_status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid')`,
        [client_name, email, phone, service_type, date, total_price, (type==='deposit' ? 15 : total_price)]
    );

    // Envoi Email
    const mailOptions = {
        from: 'aliouking.14@gmail.com',
        to: email,
        subject: 'Confirmation de Rendez-vous - Repair Phone BX',
        text: `Bonjour ${client_name},\n\nVotre rendez-vous pour ${service_type} est confirmé pour le ${date}.\n\nVous avez payé : ${type === 'deposit' ? '15€ (Acompte)' : total_price + '€ (Total)'}.\n${type === 'deposit' ? 'Reste à payer sur place : ' + (total_price - 15) + '€.' : 'Tout est réglé.'}\n\nAdresse : Ribaucourt, 1080 Molenbeek.\n\nMerci,\nL'équipe Repair Phone BX.`
    };
    transporter.sendMail(mailOptions);

    res.send(`
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font-family:sans-serif;text-align:center;padding:50px;}</style></head>
        <body><h1 style="color:green">Paiement Réussi ! ✅</h1><p>Merci ${client_name}. Un email de confirmation a été envoyé à ${email}.</p><a href="/">Retour au site</a></body></html>
    `);
});

app.get('/cancel', (req, res) => res.redirect('/'));

// --- AVIS ---
app.get('/reviews', async (req, res) => { const r = await pool.query('SELECT * FROM reviews ORDER BY id DESC'); res.json(r.rows); });
app.post('/reviews', async (req, res) => { await pool.query('INSERT INTO reviews (author, content, rating) VALUES ($1, $2, $3)', [req.body.author, req.body.content, req.body.rating]); res.json({s:true}); });

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, '../index.html')); });
app.get('/admin-secret-dashboard', (req, res) => { res.sendFile(path.join(__dirname, '../admin.html')); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`🚀 Serveur prêt sur le port ${PORT}`);
    await initDB(); 
});