const admin = require('firebase-admin');
const axios = require('axios');

// Your Google Apps Script Tunnel URL
const TUNNEL_URL = "https://script.google.com/macros/s/AKfycbzG2lQUiwgoU_TxitrLrpXTpF9nZw5LnJreMlhxM7qupa-Wpm94qlronU4wwje8kW-8/exec"; 

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT secret!");
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Helper to extract the number from strings like "6.125%"
const grabNum = (text) => {
    const match = text.match(/(\d+\.\d+)/);
    return match ? parseFloat(match[1]) : 0;
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
        console.log(`--- Fetching ${lender.name} via Google Tunnel ---`);
        try {
            // We route the request through your Google Apps Script
            const response = await axios.get(`${TUNNEL_URL}?url=${encodeURIComponent(lender.url)}`, { timeout: 30000 });
            const html = response.data;

            // Using Regex to find common rate patterns in the HTML source
            const vaMatch = html.match(/VA[^\d]{1,50}(\d+\.\d+)%/i);
            const convMatch = html.match(/30-Year Fixed[^\d]{1,50}(\d+\.\d+)%/i) || html.match(/Conventional[^\d]{1,50}(\d+\.\d+)%/i);

            if (vaMatch && vaMatch[1]) {
                const rate = grabNum(vaMatch[1]);
                results.push({
                    lender: lender.name, product: '30yr VA', date: today,
                    rate: rate, apr: rate + 0.18, points: 0,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ Found VA: ${rate}%`);
            }

            if (convMatch && convMatch[1]) {
                const rate = grabNum(convMatch[1]);
                results.push({
                    lender: lender.name, product: '30yr Conv', date: today,
                    rate: rate, apr: rate + 0.22, points: 0,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ Found Conv: ${rate}%`);
            }

            if (!vaMatch && !convMatch) {
                console.warn(`⚠️ Warning: No rates found in the HTML for ${lender.name}.`);
            }

        } catch (err) {
            console.error(`❌ ${lender.name} Tunnel Error: ${err.message}`);
        }
    }

    if (results.length > 0) {
        console.log(`Pushing ${results.length} updates to Firestore...`);
        const batch = db.batch();
        results.forEach(res => {
            const docId = `${res.date}_${res.lender}_${res.product.replace(/\s/g, '_')}`;
            batch.set(db.collection('mortgage_rates').doc(docId), res);
        });
        await batch.commit();
        console.log("Database successfully updated.");
    } else {
        console.error("Final Result: No rates found at all. Check Google Tunnel logs.");
    }
}

scrapeLenders().catch(console.error);
