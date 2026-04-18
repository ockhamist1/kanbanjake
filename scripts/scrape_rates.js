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

// Looking for a rate between 4.5% and 9.5%
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
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&wait_until=networkidle`;
            const response = await axios.get(proxyUrl, { timeout: 120000 });
            
            // Clean the data: remove tags but keep numbers and decimals intact
            let cleanText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            cleanText = cleanText.replace(/<[^>]*>/g, ' | ').replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['Conventional', '30-Year Fixed', '30 Year Fixed', '30yr Fixed'] },
                { id: '30yr VA', keys: ['VA Loan', 'VA Fixed', 'Veteran', 'VA 30', 'V.A.'] }
            ];

            for (const conf of configs) {
                // Search 2000 characters around the product name
                const regex = new RegExp(`(${conf.keys.join('|')})[^|]{1,2000}`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[0];
                    // Find ALL decimal numbers in this block
                    const decimals = block.match(/(\d+\.\d+)/g);
                    
                    if (decimals) {
                        const nums = decimals.map(n => parseFloat(n));
                        // The Rate is the first number in the 4.5 - 9.5 range
                        const rate = nums.find(n => isSaneRate(n));
                        
                        if (rate) {
                            // APR is the next number >= Rate
                            const apr = nums.find(n => n > rate && n < rate + 1.2) || (rate + 0.23);
                            // Points is any small number < 3.0 that isn't the rate or APR
                            const points = nums.find(n => n > 0 && n < 3.0 && n !== rate && n !== apr) || 0;

                            results.push({
                                lender: lender.name, product: conf.id, date: today,
                                rate, apr, points, timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                            console.log(`   ✅ ${conf.id}: ${rate}% (Points: ${points})`);
                        } else {
                            console.log(`   ⚠️ Found keywords for ${conf.id}, but no rate in 4.5-9.5 range. Snippet: ${block.substring(0, 150)}`);
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
        console.log(`>>> SAVING: Pushing ${results.length} records...`);
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(">>> UPDATE COMPLETE.");
    }
}

run();
