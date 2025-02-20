require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 8080;

// Increase the body size limit
app.use(bodyParser.json({ limit: "50mb" }));  // Increase to 50MB
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Middleware
app.use(cors({
    origin: [
        "https://heartsforever.co.uk",                  // Production frontend
        "http://localhost:3000",                        // Local development
        `https://${process.env.SHOPIFY_SHOP_DOMAIN}`,   // Shopify store
        "https://admin.shopify.com"                     // Shopify admin
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

// ✅ Manually Handle Preflight Requests
app.options("*", (req, res) => {
    const origin = req.headers.origin;
    if (origin && [
        "https://heartsforever.co.uk",
        "http://localhost:3000",
        `https://${process.env.SHOPIFY_SHOP_DOMAIN}`,
        "https://admin.shopify.com"
    ].includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
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
        // Debug logging
        console.log('Headers:', req.headers);
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('Files:', req.files);

        // Validate required fields with detailed error
        const requiredFields = ['firstName', 'lastName', 'email', 'phone'];
        const missingFields = requiredFields.filter(field => !req.body[field]);
        
        if (missingFields.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: `Missing required fields: ${missingFields.join(', ')}` 
            });
        }

        // Extract Form Data
        const formData = req.body;
        const files = req.files; // Uploaded images

        // **(1) Upload Images to Shopify Files API** (If images are included)
        let uploadedImageURLs = [];
        if (files && files.length > 0) {
            for (const file of files) {
                try {
                    console.log('Attempting to upload file:', file.originalname);
                    const imageResponse = await axios.post(
                        SHOPIFY_ADMIN_API_URL,
                        {
                            query: `
                            mutation fileCreate($files: [FileCreateInput!]!) {
                                fileCreate(files: $files) {
                                    files {
                                        url
                                        id
                                    }
                                    userErrors {
                                        field
                                        message
                                    }
                                }
                            }`,
                            variables: {
                                files: [{
                                    originalSource: file.originalname,
                                    contentType: file.mimetype,
                                    filename: file.originalname,
                                    fileSize: file.size,
                                    data: file.buffer.toString('base64')
                                }]
                            }
                        },
                        { 
                            headers: {
                                ...getShopifyHeaders(),
                                'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
                            }
                        }
                    );

                    console.log('Shopify GraphQL Response:', JSON.stringify(imageResponse.data, null, 2));

                    // More robust error checking
                    if (imageResponse.data.data.fileCreate.userErrors.length > 0) {
                        console.error('Shopify file upload errors:', 
                            JSON.stringify(imageResponse.data.data.fileCreate.userErrors, null, 2)
                        );
                        continue; // Skip this file but continue with others
                    }

                    const imageUrl = imageResponse.data.data.fileCreate.files[0]?.url;
                    if (imageUrl) {
                        console.log('Successfully uploaded file:', file.originalname, 'URL:', imageUrl);
                        uploadedImageURLs.push(imageUrl);
                    }
                } catch (uploadError) {
                    console.error('Detailed Upload Error for file', file.originalname, ':', 
                        uploadError.response ? uploadError.response.data : uploadError
                    );
                }
            }
        }
        
        // Create metafield data with uploaded image URLs
        const metafieldData = {
            query: `
                mutation metafieldCreate($input: MetafieldInput!) {
                    metafieldCreate(metafield: $input) {
                        metafield {
                            id
                            namespace
                            key
                            value
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `,
            variables: {
                input: {
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
                            brand: formData.brand,
                            modelNo: formData.modelNo,
                            condition: formData.condition,
                            hasBox: formData.hasBox,
                            hasPapers: formData.hasPapers,
                            askingPrice: formData.askingPrice,
                            additionalInfo: formData.additionalInfo
                        },
                        images: uploadedImageURLs,
                        submittedAt: new Date().toISOString()
                    }),
                    ownerId: `gid://shopify/Shop/${process.env.SHOP_ID}`
                }
            }
        };

        // Log before Shopify API call
        console.log('Sending to Shopify:', JSON.stringify(metafieldData, null, 2));

        // Send to Shopify
        const shopifyResponse = await axios.post(
            SHOPIFY_ADMIN_API_URL,
            metafieldData,
            { headers: getShopifyHeaders() }
        );

        console.log('Shopify Response:', JSON.stringify(shopifyResponse.data, null, 2));

        // Send email notification
        await sendEmailNotification(
            `${formData.firstName} ${formData.lastName}`,
            formData.email,
            formData.additionalInfo || '',
            uploadedImageURLs
        );

        res.json({ 
            success: true, 
            message: "Form submitted successfully!" 
        });

    } catch (error) {
        console.error('Detailed server error:', {
            message: error.message,
            stack: error.stack,
            response: error.response?.data,
            request: error.config
        });
        
        res.status(500).json({ 
            success: false, 
            message: "Internal server error",
            error: error.message,
            details: error.response?.data
        });
    }
});

// ✅ **Utility Function to Get Shopify API Headers**
function getShopifyHeaders() {
    return {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json"
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

// Add health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
