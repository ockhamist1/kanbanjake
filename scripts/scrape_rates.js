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

// Snatches a rate (looking for 4.5% to 9.5%)
const findActualRate = (text) => {
    // Looks for numbers like 6.125 or 7.0 followed by % or in a table cell
    const matches = text.match(/([4-9]\.\d{2,3})/g);
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
        console.log(`>>> STARTING: ${lender.name}`);
        try {
            // UPDATED: Added premium=true and increased timeout to 90s
            // Premium proxies are much harder for Rocket/USAA to block
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true`;
            
            const response = await axios.get(proxyUrl, { timeout: 95000 });
            console.log(`<<< DATA RECEIVED: ${lender.name}`);

            let cleanText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            cleanText = cleanText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

            const productConfigs = [
                { type: '30yr Conv', keywords: ['Conventional', '30-Year Fixed', '30yr Fixed', '30 Year Fixed'] },
                { type: '30yr VA', keywords: ['VA Loan', 'VA Fixed', 'Veteran', 'VA 30', 'V.A.'] }
            ];

            for (const prod of productConfigs) {
                // We use a much larger 3000-character block to ensure we find the VA table
                const regex = new RegExp(`(${prod.keywords.join('|')})[\\s\\S]{1,3000}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    const allDecimals = block.match(/(\d+\.\d+)/g);
                    
                    const rate = allDecimals ? parseFloat(allDecimals.find(n => parseFloat(n) >= 4.5 && parseFloat(n) <= 9.5)) : 0;

                    if (rate > 0) {
                        // APR logic: Find the next rate in the block that is > rate
                        const apr = allDecimals.find(n => parseFloat(n) > rate && parseFloat(n) < (rate + 1.5)) || (rate + 0.25);
                        
                        // Points logic: Look for small decimals < 3.0 that aren't the rate/APR
                        const points = allDecimals.find(n => {
                            const v = parseFloat(n);
                            return v > 0 && v < 3.0 && v !== rate && v !== parseFloat(apr);
                        }) || 0;

                        results.push({
                            lender: lender.name,
                            product: prod.type,
                            date: today,
                            rate: rate,
                            apr: parseFloat(apr),
                            points: parseFloat(points),
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`   ✅ ${prod.type}: ${rate}% | APR: ${apr}% | Points: ${points}`);
                    } else {
                        console.log(`   ⚠️ Keywords found for ${prod.type} but no rate in 4.5-9.5% range.`);
                    }
                } else {
                    console.log(`   ⚠️ Keywords not found for ${prod.type}`);
                }
            }
        } catch (err) {
            console.error(`   ❌ ${lender.name} FAILED: ${err.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`>>> SAVING: Pushing ${results.length} records...`);
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(">>> SUCCESS: Database updated.");
    }
}

run().catch(err => console.error("FATAL ERROR:", err));
