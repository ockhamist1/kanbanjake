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

// Helper to find a number in a string within a specific range
const findRateInRange = (text, min, max) => {
    const matches = text.match(/(\d+\.\d+)/g);
    if (!matches) return 0;
    const found = matches.find(n => {
        const val = parseFloat(n);
        return val >= min && val <= max;
    });
    return found ? parseFloat(found) : 0;
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
            // Using render=true but with a shorter timeout to prevent hanging
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true`;
            const response = await axios.get(proxyUrl, { timeout: 60000 });
            const html = response.data;

            const productConfigs = [
                { type: '30yr Conv', keywords: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { type: '30yr VA', keywords: ['VA Fixed', '30-Year VA', '30 Year VA'] }
            ];

            for (const prod of productConfigs) {
                // Find the section of the page mentioning the product
                const regex = new RegExp(`(${prod.keywords.join('|')})[\\s\\S]{1,500}`, 'i');
                const match = html.match(regex);

                if (match) {
                    const block = match[0];
                    console.log(`Found block for ${lender.name} ${prod.type}: ${block.substring(0, 100)}...`);

                    // 1. Rate: Look for numbers between 5% and 9%
                    const rate = findRateInRange(block, 5.0, 9.0);
                    
                    // 2. Points: Look for numbers between 0.0 and 3.0 (Points are usually low)
                    // We look for the word "Points" first
                    let points = 0;
                    const pointsMatch = block.match(/points[^\d]{1,20}(\d+\.\d+)/i);
                    if (pointsMatch) {
                        points = parseFloat(pointsMatch[1]);
                    } else {
                        // Fallback: Find the first small decimal that isn't the rate
                        const smallDecimals = block.match(/(\d+\.\d+)/g);
                        if (smallDecimals) {
                            const p = smallDecimals.find(n => parseFloat(n) > 0 && parseFloat(n) < 3.0);
                            points = p ? parseFloat(p) : 0;
                        }
                    }

                    // 3. APR: Usually the second number in the 5-9% range
                    let apr = 0;
                    const aprMatches = block.match(/(\d+\.\d+)/g);
                    if (aprMatches) {
                        const possibleAPRs = aprMatches.filter(n => parseFloat(n) >= rate && parseFloat(n) < 10);
                        apr = possibleAPRs.length > 1 ? parseFloat(possibleAPRs[1]) : rate + 0.15;
                    }

                    if (rate > 0) {
                        results.push({
                            lender: lender.name,
                            product: prod.type,
                            date: today,
                            rate: rate,
                            apr: apr,
                            points: points,
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`✅ ${lender.name} ${prod.type}: Rate ${rate}% | APR ${apr}% | Points ${points}`);
                    }
                } else {
                    console.warn(`⚠️ ${lender.name}: Could not find keywords for ${prod.type}`);
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
        console.log(`Success! Saved ${results.length} updates.`);
    }
}

run().catch(err => console.error("GLOBAL ERROR:", err));
