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
        console.log('Processing form submission...');
        
        let uploadedImageURLs = [];
        if (req.body.images) {
            const images = req.body.images;
            for (const [key, value] of Object.entries(images)) {
                if (value && typeof value === 'string') {
                    try {
                        // Handle both raw base64 and data URI formats
                        let base64Data = value;
                        if (value.startsWith('data:image')) {
                            base64Data = value.split(',')[1];
                        }
                        
                        // Validate base64 content
                        if (!base64Data) {
                            console.error('Invalid base64 data for', key);
                            continue;
                        }

                        console.log(`Uploading image for ${key}...`);
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
                                        originalSource: `${key}-image.jpg`,
                                        contentType: 'image/jpeg',
                                        filename: `${key}-image.jpg`,
                                        fileSize: Buffer.from(base64Data, 'base64').length,
                                        data: base64Data
                                    }]
                                }
                            },
                            { 
                                headers: getShopifyHeaders()
                            }
                        );

                        if (imageResponse.data.data?.fileCreate?.files?.[0]?.url) {
                            uploadedImageURLs.push(imageResponse.data.data.fileCreate.files[0].url);
                            console.log(`Successfully uploaded ${key} image`);
                        } else {
                            console.error('No URL in response for', key, ':', imageResponse.data);
                        }
                    } catch (uploadError) {
                        console.error('Image upload error for', key, ':', uploadError.message);
                        if (uploadError.response) {
                            console.error('Response data:', uploadError.response.data);
                        }
                    }
                }
            }
        }

        // Create form submission data
        const formData = {
            ...req.body,
            images: uploadedImageURLs
        };

        // Create metafield with the form data
        const metafieldResponse = await axios.post(
            SHOPIFY_ADMIN_API_URL,
            {
                query: `mutation metafieldCreate($input: MetafieldInput!) {
                    metafieldCreate(metafield: $input) {
                        metafield {
                            id
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }`,
                variables: {
                    input: createMetafieldData(formData)
                }
            },
            { headers: getShopifyHeaders() }
        );

        if (metafieldResponse.data.data?.metafieldCreate?.userErrors?.length > 0) {
            throw new Error(JSON.stringify(metafieldResponse.data.data.metafieldCreate.userErrors));
        }

        // Send email notification
        await sendEmailNotification(
            `${formData.firstName} ${formData.lastName}`,
            formData.email,
            formData.additionalInfo || '',
            uploadedImageURLs
        );

        res.json({ 
            success: true, 
            message: "Form submitted successfully!",
            uploadedImages: uploadedImageURLs
        });

    } catch (error) {
        console.error('Form submission error:', {
            message: error.message,
            stack: error.stack,
            responseData: error.response?.data,
            requestBody: error.config?.data
        });
        
        res.status(500).json({ 
            success: false, 
            message: "Error processing form submission",
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
