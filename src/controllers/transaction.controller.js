const transactionModel = require("../models/transaction.model")
const ledgerModel = require("../models/ledger.model")
const accountModel = require("../models/account.model")
const emailService = require("../services/email.service")
const mongoose = require("mongoose")

/**
 * - Create a new transaction
 * THE 10-STEP TRANSFER FLOW:
 * 1. Validate request
 * 2. Validate idempotency key
 * 3. Verify accounts and sender authorization (Anti-BOLA)
 * 4. Verify account status and currency compatibility
 * 5. Start MongoDB session & ACID transaction
 * 6. Derive sender balance from ledger within session (anti-race condition)
 * 7. Create transaction (PENDING)
 * 8. Create DEBIT & CREDIT ledger entries
 * 9. Mark transaction COMPLETED & commit session
 * 10. Send email notification (non-blocking)
 */
async function createTransaction(req, res) {
    const { fromAccount, toAccount, amount, idempotencyKey } = req.body

    // 1. Basic validation
    if (!fromAccount || !toAccount || !amount || !idempotencyKey) {
        return res.status(400).json({
            message: "fromAccount, toAccount, amount and idempotencyKey are required"
        })
    }

    if (typeof amount !== "number" || amount <= 0 || !Number.isFinite(amount)) {
        return res.status(400).json({
            message: "Amount must be a positive number"
        })
    }

    if (fromAccount.toString() === toAccount.toString()) {
        return res.status(400).json({
            message: "Cannot transfer money to the same account"
        })
    }

    // 2. Validate idempotency key
    const isTransactionAlreadyExists = await transactionModel.findOne({
        idempotencyKey: idempotencyKey
    })

    if (isTransactionAlreadyExists) {
        if (isTransactionAlreadyExists.status === "COMPLETED") {
            return res.status(200).json({
                message: "Transaction already processed",
                transaction: isTransactionAlreadyExists
            })
        }

        if (isTransactionAlreadyExists.status === "PENDING") {
            return res.status(200).json({
                message: "Transaction is still processing"
            })
        }

        if (isTransactionAlreadyExists.status === "FAILED") {
            return res.status(409).json({
                message: "Transaction processing failed previously, please retry with a new idempotency key"
            })
        }

        if (isTransactionAlreadyExists.status === "REVERSED") {
            return res.status(409).json({
                message: "Transaction was reversed previously, please retry with a new idempotency key"
            })
        }
    }

    // 3. Verify account existence and ownership
    const fromUserAccount = await accountModel.findById(fromAccount)
    const toUserAccount = await accountModel.findById(toAccount)

    if (!fromUserAccount || !toUserAccount) {
        return res.status(404).json({
            message: "Invalid fromAccount or toAccount"
        })
    }

    // CRITICAL: Ensure the authenticated user owns the fromAccount (BOLA / IDOR protection)
    if (fromUserAccount.user.toString() !== req.user._id.toString()) {
        return res.status(403).json({
            message: "You are not authorized to transfer from this account"
        })
    }

    // 4. Verify account status and currency
    if (fromUserAccount.status !== "ACTIVE" || toUserAccount.status !== "ACTIVE") {
        return res.status(400).json({
            message: "Both fromAccount and toAccount must be ACTIVE to process transaction"
        })
    }

    if (fromUserAccount.currency !== toUserAccount.currency) {
        return res.status(400).json({
            message: `Currency mismatch: sender currency is ${fromUserAccount.currency} and receiver currency is ${toUserAccount.currency}`
        })
    }

    // 5. MongoDB session and atomic execution
    const session = await mongoose.startSession()
    session.startTransaction()

    let transaction
    try {
        // 6. Check balance within session to prevent race conditions (TOCTOU)
        const balance = await fromUserAccount.getBalance(session)

        if (balance < amount) {
            await session.abortTransaction()
            return res.status(400).json({
                message: `Insufficient balance. Current balance is ${balance}. Requested amount is ${amount}`
            })
        }

        // 7. Create transaction (PENDING)
        transaction = (await transactionModel.create([ {
            fromAccount,
            toAccount,
            amount,
            idempotencyKey,
            status: "PENDING"
        } ], { session }))[ 0 ]

        // 8. Create DEBIT & CREDIT entries in immutable ledger
        await ledgerModel.create([ {
            account: fromAccount,
            amount: amount,
            transaction: transaction._id,
            type: "DEBIT"
        } ], { session })

        await ledgerModel.create([ {
            account: toAccount,
            amount: amount,
            transaction: transaction._id,
            type: "CREDIT"
        } ], { session })

        // 9. Mark transaction COMPLETED
        await transactionModel.findByIdAndUpdate(
            transaction._id,
            { status: "COMPLETED" },
            { session }
        )

        transaction.status = "COMPLETED"

        await session.commitTransaction()
    } catch (error) {
        await session.abortTransaction()

        if (error.code === 11000) {
            return res.status(409).json({
                message: "A transaction with this idempotency key is already being processed"
            })
        }

        return res.status(500).json({
            message: "Transaction failed to process, please try again",
            error: error.message
        })
    } finally {
        session.endSession()
    }

    // 10. Send email notification non-blocking (does not delay or break HTTP response)
    emailService.sendTransactionEmail(req.user.email, req.user.name, amount, toAccount)
        .catch(err => console.error("Failed to send transaction email:", err.message))

    return res.status(201).json({
        message: "Transaction completed successfully",
        transaction: transaction
    })
}

/**
 * - Create initial funds transaction from system user
 */
async function createInitialFundsTransaction(req, res) {
    const { toAccount, amount, idempotencyKey } = req.body

    if (!toAccount || !amount || !idempotencyKey) {
        return res.status(400).json({
            message: "toAccount, amount and idempotencyKey are required"
        })
    }

    if (typeof amount !== "number" || amount <= 0 || !Number.isFinite(amount)) {
        return res.status(400).json({
            message: "Amount must be a positive number"
        })
    }

    const toUserAccount = await accountModel.findById(toAccount)
    if (!toUserAccount) {
        return res.status(404).json({
            message: "Invalid toAccount"
        })
    }

    if (toUserAccount.status !== "ACTIVE") {
        return res.status(400).json({
            message: "Target account must be ACTIVE"
        })
    }

    const fromUserAccount = await accountModel.findOne({
        user: req.user._id
    })

    if (!fromUserAccount) {
        return res.status(400).json({
            message: "System user account not found"
        })
    }

    // Check idempotency
    const existingTx = await transactionModel.findOne({ idempotencyKey })
    if (existingTx) {
        return res.status(200).json({
            message: "Initial funds transaction already processed",
            transaction: existingTx
        })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    let transaction
    try {
        transaction = (await transactionModel.create([ {
            fromAccount: fromUserAccount._id,
            toAccount,
            amount,
            idempotencyKey,
            status: "PENDING"
        } ], { session }))[ 0 ]

        await ledgerModel.create([ {
            account: fromUserAccount._id,
            amount: amount,
            transaction: transaction._id,
            type: "DEBIT"
        } ], { session })

        await ledgerModel.create([ {
            account: toAccount,
            amount: amount,
            transaction: transaction._id,
            type: "CREDIT"
        } ], { session })

        await transactionModel.findByIdAndUpdate(
            transaction._id,
            { status: "COMPLETED" },
            { session }
        )

        transaction.status = "COMPLETED"

        await session.commitTransaction()
    } catch (error) {
        await session.abortTransaction()

        if (error.code === 11000) {
            return res.status(409).json({
                message: "A transaction with this idempotency key already exists"
            })
        }

        return res.status(500).json({
            message: "Initial funds transaction failed",
            error: error.message
        })
    } finally {
        session.endSession()
    }

    return res.status(201).json({
        message: "Initial funds transaction completed successfully",
        transaction: transaction
    })
}

module.exports = {
    createTransaction,
    createInitialFundsTransaction
}
