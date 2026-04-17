const admin = require('firebase-admin');
const axios = require('axios');

const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const FIREBASE_KEY = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!SCRAPER_KEY || !FIREBASE_KEY) {
    console.error("Missing Secrets!");
    process.exit(1);
}

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_KEY)) });
}
const db = admin.firestore();

const LENDERS = [
    { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
    { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
    { name: 'Rocket', url: 'https://www.rocketmortgage.com/mortgage-rates' },
    { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
];

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    for (const lender of LENDERS) {
        console.log(`--- Fetching ${lender.name} ---`);
        try {
            // render=true is key here: it waits for the bank's JS to finish
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true`;
            const response = await axios.get(proxyUrl, { timeout: 90000 }); // Increased timeout for heavy JS pages
            
            const html = JSON.stringify(response.data);
            
            // This Regex looks for a rate (e.g., 6.375 or 7.12) near the word "30" or "VA"
            // We search for a decimal number between 4.0 and 9.0
            const rateMatch = html.match(/([4-8]\.\d{2,3})/g); 

            if (rateMatch && rateMatch.length > 0) {
                // We take the first sensible rate found on the page
                const rate = parseFloat(rateMatch[0]);
                results.push({
                    lender: lender.name,
                    product: '30yr Conv',
                    date: today,
                    rate: rate,
                    apr: rate + 0.21, 
                    points: 0,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ ${lender.name}: Found ${rate}%`);
            } else {
                console.warn(`⚠️ ${lender.name}: No rate pattern found in page content.`);
            }
        } catch (err) {
            console.error(`❌ ${lender.name} Failed: ${err.message}`);
        }
    }

    if (results.length > 0) {
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(`Success! Saved ${results.length} lenders.`);
    }
}

run();
