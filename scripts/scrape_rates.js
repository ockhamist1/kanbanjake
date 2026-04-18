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

// Only accept numbers that look like current mortgage rates
const isSaneRate = (val) => val >= 4.5 && val <= 9.5;

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    const LENDERS = [
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/mortgage-rates' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
    ];

    for (const lender of LENDERS) {
        console.log(`>>> FETCHING: ${lender.name}`);
        try {
            // Added wait_for_selector to ensure the rate tables are actually there
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&wait_until=networkidle`;
            const response = await axios.get(proxyUrl, { timeout: 120000 });
            
            let data = response.data;
            if (typeof data !== 'string') data = JSON.stringify(data);

            // CRITICAL STEP: Strip out the "Noise" (Style, Scripts, Tags)
            const cleanText = data
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi, '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['30-Year VA', '30 Year VA', 'VA Loan', 'Veteran'] }
            ];

            for (const conf of configs) {
                // Search for the product name and look at the next 1000 characters
                const regex = new RegExp(`(${conf.keys.join('|')})(.{1,1000})`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[2];
                    // Look for decimals followed by a % or just decimals in the sane range
                    const rateMatches = block.match(/(\d+\.\d+)(?=\s?%)/g) || block.match(/(\d+\.\d+)/g);
                    
                    if (rateMatches) {
                        const nums = rateMatches.map(n => parseFloat(n));
                        const rate = nums.find(n => isSaneRate(n));
                        
                        if (rate) {
                            const apr = nums.find(n => n > rate && n < rate + 1.2) || (rate + 0.25);
                            const points = nums.find(n => n > 0 && n < 3.0 && n !== rate && n !== apr) || 0;

                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate, apr, points, timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`   ✅ ${conf.id}: ${rate}%`);
                        }
                    }
                } else {
                    console.log(`   ⚠️ Keywords not found for ${conf.id}`);
                }
            }
        } catch (err) {
            console.error(`   ❌ ERROR: ${lender.name} - ${err.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`>>> SAVING: ${results.length} items.`);
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
    }
}

run();
