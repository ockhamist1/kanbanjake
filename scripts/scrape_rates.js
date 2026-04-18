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

// Snatches the first real interest rate (4.5% to 9.5%)
const findActualRate = (text) => {
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
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true`;
            const response = await axios.get(proxyUrl, { timeout: 60000 });
            
            // Convert everything to a clean string for searching
            let cleanText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            cleanText = cleanText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

            const productConfigs = [
                { type: '30yr Conv', keywords: ['Conventional', '30-Year Fixed', '30 Year Fixed', '30yr Fixed'] },
                { type: '30yr VA', keywords: ['VA Fixed', '30-Year VA', '30yr VA', 'Veteran', 'V.A.'] }
            ];

            for (const prod of productConfigs) {
                // Find a massive block around the keyword
                const regex = new RegExp(`(${prod.keywords.join('|')})[\\s\\S]{1,2000}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    const allDecimals = block.match(/(\d+\.\d+)/g);
                    
                    // 1. Rate: Look for the first number between 4.5 and 9.0
                    const rate = allDecimals ? parseFloat(allDecimals.find(n => parseFloat(n) >= 4.5 && parseFloat(n) <= 9.0)) : 0;

                    if (rate > 0) {
                        // 2. APR: Look for the number that is >= Rate but < Rate + 1.0
                        const apr = allDecimals.find(n => {
                            const v = parseFloat(n);
                            return v >= rate && v < (rate + 1.2) && v !== rate;
                        }) || (rate + 0.22);

                        // 3. Points: Look for a small number (usually 0.0 to 2.5) that isn't the rate or APR
                        const points = allDecimals.find(n => {
                            const v = parseFloat(n);
                            return v > 0 && v < 3.0 && v !== parseFloat(rate) && v !== parseFloat(apr);
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
                        console.log(`   ⚠️ Found keywords for ${prod.type} but no valid rate in the data block.`);
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
