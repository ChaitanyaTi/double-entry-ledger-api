const express = require("express")
const cookieParser = require("cookie-parser")

const app = express()

app.use(express.json())
app.use(cookieParser())

/**
 * - Routes required
 */
const authRouter = require("./routes/auth.routes")
const accountRouter = require("./routes/account.routes")
const transactionRoutes = require("./routes/transaction.routes")

/**
 * - Health Check Route
 */
app.get("/", (req, res) => {
    res.json({
        status: "success",
        message: "Ledger Service is up and running"
    })
})

/**
 * - Mount API Routes
 */
app.use("/api/auth", authRouter)
app.use("/api/accounts", accountRouter)
app.use("/api/transactions", transactionRoutes)

/**
 * - 404 Route Handler
 */
app.use((req, res) => {
    res.status(404).json({
        message: `Route ${req.method} ${req.originalUrl} not found`
    })
})

/**
 * - Centralized Error Handler Middleware
 */
app.use((err, req, res, next) => {
    // Handle invalid MongoDB ObjectId
    if (err.name === "CastError") {
        return res.status(400).json({
            message: `Invalid ID format for field '${err.path}'`
        })
    }

    // Handle Mongoose validation errors
    if (err.name === "ValidationError") {
        const messages = Object.values(err.errors).map(val => val.message)
        return res.status(400).json({
            message: "Validation failed",
            errors: messages
        })
    }

    // Handle duplicate key error (MongoDB 11000)
    if (err.code === 11000) {
        const field = Object.keys(err.keyValue || {})[ 0 ]
        return res.status(409).json({
            message: `${field ? field.charAt(0).toUpperCase() + field.slice(1) : "Record"} already exists`
        })
    }

    const statusCode = err.statusCode || err.status || 500
    res.status(statusCode).json({
        message: err.message || "Internal Server Error"
    })
})

module.exports = app