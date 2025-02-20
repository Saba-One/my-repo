require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors({
    origin: [
        process.env.SHOPIFY_SHOP_DOMAIN, // Your Shopify store domain
        "https://admin.shopify.com", // Allows Shopify Admin requests
        "https://heartsforever.co.uk", // Your live site
        "http://localhost:3000" // Local development
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

// ✅ Manually Handle Preflight Requests
app.options("*", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*"); // Change "*" to your Shopify store later
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.sendStatus(200);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer Setup for Handling File Uploads (Images)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Update GraphQL endpoint to use correct env variable
const SHOPIFY_ADMIN_API_URL = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2023-10/graphql.json`;

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
                    SHOPIFY_ADMIN_API_URL,
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
        const metafieldData = createMetafieldData({
            name,
            email,
            message,
            checkbox,
            images: uploadedImageURLs
        });

        await axios.post(
            SHOPIFY_ADMIN_API_URL,
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

// Utility function to create metafield data
function createMetafieldData(formData) {
    return {
        namespace: "custom_forms",
        key: "valuation_form",
        type: "json",
        value: JSON.stringify({
            customerInfo: {
                firstName: formData.firstName,
                lastName: formData.lastName,
                email: formData.email,
                phone: formData.phone,
                referralSource: formData.referralSource
            },
            itemDetails: {
                category: formData.category,
                // Watch-specific fields
                brand: formData.brand,
                modelNo: formData.modelNo,
                condition: formData.condition,
                hasBox: formData.hasBox,
                hasPapers: formData.hasPapers,
                // Jewellery-specific fields
                itemType: formData.itemType,
                metalType: formData.metalType,
                diamondCarat: formData.diamondCarat,
                // Gold-specific fields
                goldKarat: formData.goldKarat,
                itemWeight: formData.itemWeight,
                // Common fields
                askingPrice: formData.askingPrice,
                additionalInfo: formData.additionalInfo
            },
            images: {
                front: formData.images.front ? {
                    file: formData.images.front.file,
                    preview: formData.images.front.preview
                } : null,
                back: formData.images.back ? {
                    file: formData.images.back.file,
                    preview: formData.images.back.preview
                } : null,
                accessories: formData.images.accessories ? {
                    file: formData.images.accessories.file,
                    preview: formData.images.accessories.preview
                } : null
            },
            submittedAt: new Date().toISOString(),
            yearOfPurchase: formData.yearOfPurchase
        }),
        ownerId:`gid://shopify/Shop/${process.env.SHOP_ID}`
    };
}

// Add a simple route to check if the server is running
app.get("/", (req, res) => {
    res.send("Server is running!");
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
