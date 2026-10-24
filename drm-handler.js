const express = require('express');
const axios = require('axios');
const router = express.Router();

router.post('/drm-license', async (req, res) => {
    const licenseUrl = req.query.url || req.body.licenseUrl;
    if (!licenseUrl) {
        return res.status(400).send('License URL thevai');
    }

    try {
        const response = await axios({
            method: 'post',
            url: licenseUrl,
            data: req.body,
            headers: {
                'Content-Type': req.headers['content-type'] || 'application/octet-stream',
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
                'Origin': req.headers['origin'] || ''
            },
            responseType: 'arraybuffer',
            validateStatus: () => true
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.status(response.status).send(response.data);
    } catch (error) {
        console.error('DRM License Error:', error.message);
        res.status(500).send({ error: 'DRM proxy tholvi', details: error.message });
    }
});

module.exports = router;
