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

// Helper to find a rate that looks like a 30yr fixed (5% to 9%)
const findActualRate = (text) => {
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
        console.log(`>>> STARTING: ${lender.name}`);
        try {
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true`;
            
            // 60-second timeout for the fetch
            const response = await axios.get(proxyUrl, { timeout: 60000 });
            console.log(`<<< DATA RECEIVED: ${lender.name} (${typeof response.data})`);

            // Ensure we are working with a string (convert JSON objects to text)
            const rawContent = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            const cleanText = rawContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

            const productConfigs = [
                { type: '30yr Conv', keywords: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { type: '30yr VA', keywords: ['VA Fixed', '30-Year VA', '30 Year VA', 'Veteran'] }
            ];

            for (const prod of productConfigs) {
                // Find a massive block to capture Rate, APR, and Points
                const regex = new RegExp(`(${prod.keywords.join('|')})[\\s\\S]{1,1500}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    const rate = findActualRate(block);
                    
                    if (rate > 5) {
                        // APR is usually the next number after the rate
                        const allDecimals = block.match(/(\d+\.\d+)/g);
                        const apr = allDecimals && allDecimals.length > 1 ? parseFloat(allDecimals[1]) : rate + 0.25;
                        
                        // Points logic: Look for "Points" or a small number < 3.0
                        let points = 0;
                        const pMatch = block.match(/points[^\d]{1,20}(\d+\.\d+)/i);
                        if (pMatch) {
                            points = parseFloat(pMatch[1]);
                        } else if (allDecimals) {
                            // Find the first small decimal that isn't the rate or APR
                            const pCandidate = allDecimals.find(n => {
                                const v = parseFloat(n);
                                return v > 0 && v < 3.0;
                            });
                            points = pCandidate ? parseFloat(pCandidate) : 0;
                        }

                        results.push({
                            lender: lender.name,
                            product: prod.type,
                            date: today,
                            rate: rate,
                            apr: apr > rate ? apr : rate + 0.2,
                            points: points,
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`   ✅ ${prod.type}: ${rate}% | APR: ${apr}% | Points: ${points}`);
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
        console.log(`>>> SAVING: Pushing ${results.length} records to Firebase...`);
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
