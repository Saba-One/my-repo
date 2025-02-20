require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer Setup for Handling File Uploads (Images)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ✅ **Form Submission Endpoint**
app.post('/submit-form', upload.array('images', 5), async (req, res) => {
    try {
        // Extract Form Data
        const { name, email, message, checkbox } = req.body;  // Add more fields if needed
        const files = req.files; // Uploaded images

        // **(1) Upload Images to Shopify Files API** (If images are included)
        let uploadedImageURLs = [];
        if (files && files.length > 0) {
            for (const file of files) {
                const imageResponse = await axios.post(
                    `https://${process.env.SHOPIFY_STORE}.myshopify.com/admin/api/2023-10/graphql.json`,
                    {
                        query: `
                        mutation fileCreate($files: [FileCreateInput!]!) {
                            fileCreate(files: $files) {
                                files {
                                    url
                                }
                                userErrors {
                                    field
                                    message
                                }
                            }
                        }`,
                        variables: {
                            files: [{
                                contentType: file.mimetype,
                                filename: file.originalname,
                                fileSize: file.size,
                                data: file.buffer.toString('base64')
                            }]
                        }
                    },
                    { headers: getShopifyHeaders() }
                );

                const imageUrl = imageResponse.data.data.fileCreate.files[0]?.url;
                if (imageUrl) uploadedImageURLs.push(imageUrl);
            }
        }

        // **(2) Store Form Data in Shopify Metafields**
        const metafieldData = {
            namespace: "custom",
            key: `form_submission_${Date.now()}`,
            value: JSON.stringify({
                name,
                email,
                message,
                checkbox,
                images: uploadedImageURLs
            }),
            type: "json"
        };

        await axios.post(
            `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-10/graphql.json`,
            { metafield: metafieldData },
            { headers: getShopifyHeaders() }
        );

        // **(3) Send Email Notification**
        await sendEmailNotification(name, email, message, uploadedImageURLs);

        res.json({ success: true, message: "Form submitted successfully!" });

    } catch (error) {
        console.error("Error submitting form:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Form submission failed!" });
    }
});

// ✅ **Utility Function to Get Shopify API Headers**
function getShopifyHeaders() {
    return {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
    };
}

// ✅ **Send Email Notification**
async function sendEmailNotification(name, email, message, imageUrls) {
    const transporter = nodemailer.createTransport({
        service: "Gmail",  // Change if using another email provider
        auth: {
            user: process.env.EMAIL_USER,  // Your email
            pass: process.env.EMAIL_PASS   // Your email password
        }
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.NOTIFICATION_EMAIL, // Your email where submissions go
        subject: "New Form Submission",
        html: `
            <h2>New Form Submission</h2>
            <p><b>Name:</b> ${name}</p>
            <p><b>Email:</b> ${email}</p>
            <p><b>Message:</b> ${message}</p>
            ${imageUrls.length > 0 ? `<p><b>Images:</b></p>` + imageUrls.map(url => `<img src="${url}" width="200"/>`).join("") : ""}
        `
    };

    await transporter.sendMail(mailOptions);
}

// ✅ **Start the Server**
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
