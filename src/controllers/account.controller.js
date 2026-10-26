const accountModel = require("../models/account.model");
const ledgerModel = require("../models/ledger.model");

async function createAccountController(req, res) {
    const user = req.user;
    const { currency = "INR" } = req.body;

    const account = await accountModel.create({
        user: user._id,
        currency: currency ? currency.toUpperCase() : "INR"
    });

    res.status(201).json({
        account
    });
}

async function getUserAccountsController(req, res) {
    const accounts = await accountModel.find({ user: req.user._id });

    res.status(200).json({
        accounts
    });
}

async function getAccountBalanceController(req, res) {
    const { accountId } = req.params;

    const account = await accountModel.findOne({
        _id: accountId,
        user: req.user._id
    });

    if (!account) {
        return res.status(404).json({
            message: "Account not found"
        });
    }

    const balance = await account.getBalance();

    res.status(200).json({
        accountId: account._id,
        currency: account.currency,
        status: account.status,
        balance: balance
    });
}

async function getAccountStatementController(req, res) {
    const { accountId } = req.params;

    const account = await accountModel.findOne({
        _id: accountId,
        user: req.user._id
    });

    if (!account) {
        return res.status(404).json({
            message: "Account not found"
        });
    }

    // Retrieve ledger entries associated with this account
    const entries = await ledgerModel.find({ account: accountId })
        .populate("transaction", "idempotencyKey status createdAt")
        .sort({ _id: -1 });

    const balance = await account.getBalance();

    res.status(200).json({
        accountId: account._id,
        currency: account.currency,
        status: account.status,
        currentBalance: balance,
        totalEntries: entries.length,
        statement: entries
    });
}

module.exports = {
    createAccountController,
    getUserAccountsController,
    getAccountBalanceController,
    getAccountStatementController
};