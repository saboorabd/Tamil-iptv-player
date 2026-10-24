const express = require('express');
const axios = require('axios');
const router = express.Router();

router.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('URL thevai');
    }

    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': req.headers['referer'] || new URL(targetUrl).origin,
                'Origin': new URL(targetUrl).origin,
                'Accept': '*/*'
            },
            validateStatus: () => true
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.status(response.status);
        
        response.data.pipe(res);
    } catch (error) {
        console.error('CORS Proxy Error:', error.message);
        res.status(500).send({ error: 'Proxy tholvi', details: error.message });
    }
});

module.exports = router;
