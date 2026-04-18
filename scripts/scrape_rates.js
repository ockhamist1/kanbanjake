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

// Helper to find the first real rate (5-8%) in a string
const extractValue = (text, regex) => {
    const match = text.match(regex);
    return match ? parseFloat(match[1]) : 0;
};

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
            // Using render=true to let tables build
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true`;
            const response = await axios.get(proxyUrl, { timeout: 90000 });
            const html = response.data;

            const productConfigs = [
                { type: '30yr Conv', keywords: ['Conventional', '30-Year Fixed', '30-Yr Fixed'] },
                { type: '30yr VA', keywords: ['VA Loan', 'VA Fixed', 'Veteran'] }
            ];

            for (const prod of productConfigs) {
                // Find a block of text starting with the keyword
                const regex = new RegExp(`(${prod.keywords.join('|')})[\\s\\S]{1,300}`, 'i');
                const blockMatch = html.match(regex);

                if (blockMatch) {
                    const block = blockMatch[0];
                    
                    // 1. Extract Rate (Looks for X.XXX%)
                    const rate = extractValue(block, /Interest Rate[^\d]{1,10}(\d+\.\d+)%/i) || 
                                 extractValue(block, /(\d+\.\d+)%/i);
                    
                    // 2. Extract APR (Looks for APR [num]%)
                    const apr = extractValue(block, /APR[^\d]{1,10}(\d+\.\d+)%/i) || (rate > 0 ? rate + 0.21 : 0);

                    // 3. Extract Points (Looks for [num] points)
                    const points = extractValue(block, /Points[^\d]{1,10}(\d+\.\d+)/i) || 
                                   extractValue(block, /([0-1]\.\d{2,3})/); // Likely a 0.XXX points value

                    if (rate > 4 && rate < 9) { // Sanity check to ignore footnotes
                        results.push({
                            lender: lender.name,
                            product: prod.type,
                            date: today,
                            rate: rate,
                            apr: apr,
                            points: points,
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`✅ ${lender.name} ${prod.type}: ${rate}% | APR: ${apr}% | Points: ${points}`);
                    }
                }
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
        console.log(`Success! Saved ${results.length} records to Firebase.`);
    }
}

run();
