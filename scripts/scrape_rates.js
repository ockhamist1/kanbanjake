const admin = require('firebase-admin');
const axios = require('axios');

const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const FIREBASE_KEY = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!SCRAPER_KEY || !FIREBASE_KEY) { process.exit(1); }
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_KEY)) }); }
const db = admin.firestore();

const format3 = (val) => parseFloat(Number(val).toFixed(3));
const isSaneRate = (val) => val >= 4.0 && val <= 9.0;

async function run() {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    const LENDERS = [
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/mortgage-rates' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
    ];

    const session = Math.floor(Math.random() * 99999);

    for (const lender of LENDERS) {
        console.log(`>>> GHOST FETCH: ${lender.name}`);
        try {
            const proxyUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(lender.url)}&render=true&premium=true&country_code=us&session_number=${session}&device_type=desktop&keep_headers=true`;
            
            const response = await axios.get(proxyUrl, { timeout: 90000 });
            let rawData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            const cleanText = rawData
                .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, '')
                .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, '')
                .replace(/<[^>]*>/g, ' ') 
                .replace(/\s+/g, ' ');

            const configs = [
                { id: '30yr Conv', keys: ['30-Year Fixed', '30 Year Fixed', 'Conventional'] },
                { id: '30yr VA', keys: ['VA Loan', 'VA Fixed', 'Veteran', '30-Year VA'] }
            ];

            for (const conf of configs) {
                let rate = 0, apr = 0, points = 0;

                // 1. SCAN THE VISIBLE TEXT (Table View)
                const regex = new RegExp(`(${conf.keys.join('|')})(.{1,1200})`, 'i');
                const match = cleanText.match(regex);

                if (match) {
                    const block = match[2];
                    const decimals = block.match(/(\d+\.\d+)/g); // Only look for actual decimals first
                    if (decimals) {
                        const nums = decimals.map(n => parseFloat(n));
                        rate = nums.find(n => isSaneRate(n));
                        if (rate) {
                            apr = nums.find(n => n > rate && n < rate + 1.2) || (rate + 0.25);
                            // Points: specifically look for a small decimal that isn't the rate or APR
                            points = nums.find(n => n > 0 && n < 2.5 && n !== rate && n !== apr) || 0;
                        }
                    }
                }

                // 2. JSON DEEP SCAN (For Rocket and modern Web Apps)
                if (!rate) {
                    // This regex looks for "VA" or "Conv" then finds the NEXT rate:6.125 pattern
                    const jsonRegex = new RegExp(`(?:${conf.keys.join('|')})[\\s\\S]{1,1000}rate["\\s:]+([4-9]\\.\\d+)`, 'i');
                    const jsonMatch = rawData.match(jsonRegex);
                    if (jsonMatch) {
                        rate = parseFloat(jsonMatch[1]);
                        // Search for points within 500 chars of where we found the rate
                        const ptsMatch = rawData.substring(jsonMatch.index, jsonMatch.index + 500).match(/points["\\s:]+([0-2]\\.\\d+)/i);
                        points = ptsMatch ? parseFloat(ptsMatch[1]) : 0;
                        apr = rate + 0.25;
                    }
                }

                if (rate) {
                    results.push({
                        lender: lender.name, product: conf.id, date: today,
                        rate: format3(rate), apr: format3(apr), points: format3(points),
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`      ✅ FOUND ${lender.name} ${conf.id}: ${rate.toFixed(3)}% | Pts: ${points.toFixed(3)}`);
                } else {
                    console.log(`      ⚠️ No data found for ${lender.name} ${conf.id}`);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 3000));

        } catch (err) {
            console.error(`   ❌ ${lender.name} FAILED: ${err.message}`);
        }
    }

    if (results.length > 0) {
        const batch = db.batch();
        results.forEach(res => {
            const id = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(id), res);
        });
        await batch.commit();
        console.log(`>>> SUCCESS: Saved ${results.length} records.`);
    }
}

run();
