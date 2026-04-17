const admin = require('firebase-admin');
const axios = require('axios');

// These pull from the "Secrets" you save in GitHub
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const FIREBASE_KEY = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!SCRAPER_KEY || !FIREBASE_KEY) {
    console.error("Missing Secrets in GitHub Settings!");
    process.exit(1);
}

// Initialize Firebase
admin.initializeApp({ 
    credential: admin.credential.cert(JSON.parse(FIREBASE_KEY)) 
});
const db = admin.firestore();

const LENDERS = [
    { 
        name: 'PenFed', 
        url: 'https://www.penfed.org/mortgages/mortgage-rates/_jcr_content/root/container/main-container/mortgage_rate_table.model.json' 
    },
    { 
        name: 'NFCU', 
        url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates/_jcr_content/root/container/main/ratestable_copy.model.json' 
    },
    { 
        name: 'Rocket', 
        url: 'https://www.rocketmortgage.com/api/rates/mortgage' 
    },
    { 
        name: 'USAA', 
        url: 'https://www.usaa.com/banking/home-mortgages/rates/' 
    }
];

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    for (const lender of LENDERS) {
        console.log(`--- Fetching ${lender.name} ---`);
        try {
            // We use ScraperAPI with render=true to ensure JavaScript-heavy rates load
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true`;
            const response = await axios.get(proxyUrl, { timeout: 60000 });
            
            // We convert the data to a string to search for rate patterns (e.g., 6.125)
            const dataString = JSON.stringify(response.data);
            
            // Regex: Find a decimal number between 4 and 9 (typical rates)
            const rateMatch = dataString.match(/([5-8]\.\d{2,3})/); 

            if (rateMatch) {
                const rate = parseFloat(rateMatch[1]);
                results.push({
                    lender: lender.name,
                    product: '30yr Conv',
                    date: today,
                    rate: rate,
                    apr: rate + 0.18, // Estimated APR offset
                    points: 0,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ ${lender.name}: Successfully found rate of ${rate}%`);
            } else {
                console.warn(`⚠️ ${lender.name}: Page fetched, but no valid rates found in the data.`);
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
        console.log(`Success! Saved ${results.length} lender updates to Firebase.`);
    } else {
        console.error("No data saved. Check ScraperAPI credits or lender URLs.");
    }
}

run();
