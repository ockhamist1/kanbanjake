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

// Helper to find the first rate in a messy block of text
const findRate = (text) => {
    // Looks for 5.000 to 8.999 followed by a % or just as a decimal
    const matches = text.match(/([5-8]\.\d{2,3})/g);
    return matches ? parseFloat(matches[0]) : 0;
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
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true`;
            const response = await axios.get(proxyUrl, { timeout: 90000 });
            // Remove HTML tags and extra spaces to make the data "cleaner" to search
            const cleanText = response.data.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

            const productConfigs = [
                { type: '30yr Conv', keywords: ['Conventional', '30-Year Fixed', '30 Year Fixed'] },
                { type: '30yr VA', keywords: ['VA Loan', 'VA Fixed', 'Veteran', 'VA 30'] }
            ];

            for (const prod of productConfigs) {
                // Find a massive 1000-character block around the keyword
                const regex = new RegExp(`(${prod.keywords.join('|')})[\\s\\S]{1,1000}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    const rate = findRate(block);
                    
                    if (rate > 5) { // Only save if it looks like a real rate
                        // APR is usually the second decimal in the block
                        const allDecimals = block.match(/(\d+\.\d+)/g);
                        const apr = allDecimals && allDecimals.length > 1 ? parseFloat(allDecimals[1]) : rate + 0.25;
                        
                        // Points are usually a small number (0.xxx or 1.xxx)
                        const points = allDecimals && allDecimals.length > 2 ? parseFloat(allDecimals[allDecimals.length-1]) : 0;

                        results.push({
                            lender: lender.name,
                            product: prod.type,
                            date: today,
                            rate: rate,
                            apr: apr > rate ? apr : rate + 0.2,
                            points: points < 3 ? points : 0,
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`✅ ${lender.name} ${prod.type}: ${rate}% (APR: ${apr}%)`);
                    }
                } else {
                    console.warn(`⚠️ ${lender.name}: Keyword mismatch for ${prod.type}`);
                }
            }
        } catch (err) {
            console.error(`❌ ${lender.name} Error: ${err.message}`);
        }
    }

    if (results.length > 0) {
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(`Database updated with ${results.length} items.`);
    }
}

run();
