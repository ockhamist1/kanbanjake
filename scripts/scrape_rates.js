const admin = require('firebase-admin');
const axios = require('axios');

const TUNNEL_URL = "https://script.google.com/macros/s/AKfycbzG2lQUiwgoU_TxitrLrpXTpF9nZw5LnJreMlhxM7qupa-Wpm94qlronU4wwje8kW-8/exec"; 

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Snatches a number that looks like a mortgage rate (e.g., between 4.0 and 9.5)
const grabRate = (text) => {
    const matches = text.match(/(\d+\.\d+)/g);
    if (!matches) return 0;
    // Find the first number that isn't a "1" or "0" (likely a rate, not a footnote)
    const rate = matches.find(n => parseFloat(n) > 3 && parseFloat(n) < 10);
    return rate ? parseFloat(rate) : 0;
};

async function scrapeLenders() {
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    const lenders = [
        { name: 'PenFed', url: 'https://www.penfed.org/mortgage/mortgage-rates' },
        { name: 'NFCU', url: 'https://www.navyfederal.org/loans-cards/mortgage/mortgage-rates.html' },
        { name: 'Rocket', url: 'https://www.rocketmortgage.com/am-i-ready-to-buy/mortgage-rates' },
        { name: 'USAA', url: 'https://www.usaa.com/banking/home-mortgages/rates/' }
    ];

    for (const lender of lenders) {
        console.log(`--- Fetching ${lender.name} ---`);
        try {
            // Increased timeout to 60 seconds
            const response = await axios.get(`${TUNNEL_URL}?url=${encodeURIComponent(lender.url)}`, { timeout: 60000 });
            const html = response.data;

            const products = [
                { type: '30yr VA', patterns: [/VA[^\d]{1,100}(\d+\.\d+)%/i, /Veteran[^\d]{1,100}(\d+\.\d+)%/i] },
                { type: '30yr Conv', patterns: [/30-Year Fixed[^\d]{1,100}(\d+\.\d+)%/i, /Conventional[^\d]{1,100}(\d+\.\d+)%/i] }
            ];

            for (const prod of products) {
                let foundRate = 0;
                for (const pattern of prod.patterns) {
                    const match = html.match(pattern);
                    if (match) {
                        const val = grabRate(match[0]);
                        if (val > 0) { foundRate = val; break; }
                    }
                }

                if (foundRate > 0) {
                    results.push({
                        lender: lender.name, product: prod.type, date: today,
                        rate: foundRate, apr: foundRate + 0.2, points: 0,
                        timestamp: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`✅ ${lender.name} ${prod.type}: ${foundRate}%`);
                }
            }
        } catch (err) {
            console.error(`❌ ${lender.name} Error: ${err.message}`);
        }
    }

    if (results.length > 0) {
        const batch = db.batch();
        results.forEach(res => {
            const docId = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(docId), res);
        });
        await batch.commit();
        console.log(`Database updated with ${results.length} records.`);
    }
}

scrapeLenders();
