/* eslint-disable no-undef, no-unused-vars, no-useless-assignment */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcrypt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
}

// ── Authentication Middleware ──────────────────────────────────────────────────
// Reads the JWT from the httpOnly cookie set at login, verifies it, and attaches
// the decoded identity to req.user.  Returns 401 for missing / invalid / expired tokens.
function authenticate(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
// ───────────────────────────────────────────────────────────────────────────────

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Set up multer for file uploads using memory storage for zero-footprint
const upload = multer({ storage: multer.memoryStorage() });

// Prepopulated transactions list in memory (resets on server restart for simplicity, 
// but we can persist it to a local JSON file to make it real and persistent!)
const DATA_FILE = './server_db.json';
let transactions = [];

const defaultTransactions = [
  { id: 1, title: 'Amazon Shopping', amount: -2450.00, date: '2026-05-05', type: 'expense', category: 'Shopping' },
  { id: 2, title: 'Salary Deposit', amount: 185000.00, date: '2026-05-01', type: 'income', category: 'Salary' },
  { id: 3, title: 'Coffee Shop', amount: -350.00, date: '2026-04-30', type: 'expense', category: 'Food' },
  { id: 4, title: 'Stock Dividend', amount: 4500.00, date: '2026-04-28', type: 'income', category: 'Investment' },
];

function loadTransactions() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      transactions = JSON.parse(raw);
    } else {
      transactions = [...defaultTransactions];
      saveTransactions();
    }
  } catch (err) {
    console.error('Error loading transactions, using defaults:', err);
    transactions = [...defaultTransactions];
  }
}

function saveTransactions() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(transactions, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving transactions:', err);
  }
}

loadTransactions();

// Helper: check if Groq API key is configured
function isGroqConfigured() {
  return process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here';
}

// --- AUTHENTICATION ---
const USERS_FILE = './server_users.json';
let users = [];

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading users:', err);
  }
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}
loadUsers();

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'User already exists' });
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = { id: Date.now(), email, password: hashedPassword };
  users.push(newUser);
  saveUsers();
  res.json({ message: 'User registered successfully' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
  res.cookie('token', token, { httpOnly: true, secure: false, sameSite: 'lax' });
  res.json({ message: 'Logged in successfully', user: { id: user.id, email: user.email } });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully' });
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});
// ----------------------

// 1. GET /api/transactions
app.get('/api/transactions', authenticate, (req, res) => {
  // Return only the authenticated user's transactions.
  // Orphaned transactions (no userId) are intentionally excluded.
  const userTransactions = transactions.filter(t => t.userId === req.user.id);
  res.json(userTransactions);
});

// 2. POST /api/transactions (Manual Entry)
app.post('/api/transactions', authenticate, (req, res) => {
  const { title, amount, date, type, category } = req.body;
  if (!title || amount === undefined || !date || !type) {
    return res.status(400).json({ error: 'Title, amount, date, and type are required' });
  }

  const newTransaction = {
    id: Date.now(),
    userId: req.user.id, // ownership stamp — always from verified JWT, never from req.body
    title,
    amount: parseFloat(amount),
    date,
    type,
    category: category || 'General'
  };

  transactions.unshift(newTransaction); // Add to beginning
  saveTransactions();
  res.status(201).json(newTransaction);
});

// 3. DELETE /api/transactions/:id
app.delete('/api/transactions/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id);
  const target = transactions.find(t => t.id === id);

  // Return 404 for both non-existent and non-owned transactions.
  // This avoids revealing the existence of another user's record.
  if (!target || target.userId !== req.user.id) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  transactions = transactions.filter(t => t.id !== id);
  saveTransactions();
  res.json({ message: 'Transaction deleted successfully' });
});

// 4. POST /api/transactions/parse-statement
// Supports both pasted text (req.body.text) and file upload (req.file)
app.post('/api/transactions/parse-statement', authenticate, upload.single('statementFile'), async (req, res) => {
  let statementText = '';
  let isExcel = false;

  if (req.file) {
    const originalName = req.file.originalname.toLowerCase();
    isExcel = originalName.endsWith('.xls') || originalName.endsWith('.xlsx');
  }

  // If it's an Excel file, parse it using SheetJS (XLSX)
  if (isExcel) {
    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      // Find the header row (e.g. looking for both "Transaction Remarks" and "Transaction Date")
      let headerRowIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row && 
            row.some(cell => cell && cell.toString().toLowerCase().includes('transaction date')) &&
            row.some(cell => cell && cell.toString().toLowerCase().includes('transaction remarks'))) {
          headerRowIndex = i;
          break;
        }
      }

      if (headerRowIndex !== -1) {
        const headerRow = rows[headerRowIndex];
        const dateCol = headerRow.findIndex(cell => cell && cell.toString().toLowerCase().includes('transaction date'));
        const remarksCol = headerRow.findIndex(cell => cell && cell.toString().toLowerCase().includes('transaction remarks'));
        const withdrawalCol = headerRow.findIndex(cell => cell && cell.toString().toLowerCase().includes('withdrawal'));
        const depositCol = headerRow.findIndex(cell => cell && cell.toString().toLowerCase().includes('deposit'));
        const sNoCol = headerRow.findIndex(cell => cell && cell.toString().toLowerCase().includes('s no'));

        const parsedTxns = [];

        for (let i = headerRowIndex + 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;

          // Stop parsing if we reach "Legends Used" or "Legends"
          const firstCell = row[1] ? row[1].toString().toLowerCase() : '';
          const remarksCell = row[remarksCol] ? row[remarksCol].toString().toLowerCase() : '';
          if (firstCell.includes('legend') || remarksCell.includes('legend') || firstCell.includes('legends')) {
            break;
          }

          // Check if row has a valid S No (integer)
          const sNoVal = row[sNoCol] ? row[sNoCol].toString().trim() : '';
          if (!/^\d+$/.test(sNoVal)) {
            continue; // Skip legends, terms, balance details
          }

          // Extract values
          const rawRemarks = row[remarksCol] ? row[remarksCol].toString().trim() : 'Bank Transaction';
          const withdrawalVal = row[withdrawalCol] !== undefined ? parseFloat(row[withdrawalCol].toString().replace(/,/g, '')) : 0;
          const depositVal = row[depositCol] !== undefined ? parseFloat(row[depositCol].toString().replace(/,/g, '')) : 0;
          const rawDate = row[dateCol] ? row[dateCol].toString().trim() : '';

          let amount = 0;
          let type = 'expense';

          if (depositVal > 0) {
            amount = depositVal;
            type = 'income';
          } else if (withdrawalVal > 0) {
            amount = -withdrawalVal;
            type = 'expense';
          } else {
            continue; // skip zero values or undefined
          }

          // Parse date DD/MM/YYYY to YYYY-MM-DD
          let dateStr = new Date().toISOString().split('T')[0];
          if (rawDate) {
            const dateParts = rawDate.split(/[-/]/);
            if (dateParts.length === 3) {
              if (dateParts[0].length === 4) { // YYYY-MM-DD
                dateStr = `${dateParts[0]}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}`;
              } else { // DD-MM-YYYY or DD/MM/YYYY
                dateStr = `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;
              }
            }
          }

          // Categories
          let category = 'General';
          const lowerRemarks = rawRemarks.toLowerCase();
          if (lowerRemarks.includes('magicpin') || lowerRemarks.includes('amazon') || lowerRemarks.includes('flipkart') || lowerRemarks.includes('shop') || lowerRemarks.includes('reliance')) {
            category = 'Shopping';
          } else if (lowerRemarks.includes('south kitc') || lowerRemarks.includes('zomato') || lowerRemarks.includes('swiggy') || lowerRemarks.includes('restaurant') || lowerRemarks.includes('food') || lowerRemarks.includes('coffee') || lowerRemarks.includes('starbucks')) {
            category = 'Food';
          } else if (lowerRemarks.includes('pvr') || lowerRemarks.includes('inox') || lowerRemarks.includes('cinema') || lowerRemarks.includes('movie') || lowerRemarks.includes('netflix') || lowerRemarks.includes('spotify')) {
            category = 'Entertainment';
          } else if (lowerRemarks.includes('salary') || lowerRemarks.includes('paycheck') || lowerRemarks.includes('employer')) {
            category = 'Salary';
          } else if (lowerRemarks.includes('dividend') || lowerRemarks.includes('mutual') || lowerRemarks.includes('groww') || lowerRemarks.includes('zerodha') || lowerRemarks.includes('stock')) {
            category = 'Investment';
          } else if (lowerRemarks.includes('bill') || lowerRemarks.includes('electricity') || lowerRemarks.includes('utility') || lowerRemarks.includes('recharge') || lowerRemarks.includes('telecom') || lowerRemarks.includes('airtel') || lowerRemarks.includes('jio')) {
            category = 'Bills';
          } else if (lowerRemarks.includes('uber') || lowerRemarks.includes('ola') || lowerRemarks.includes('travel') || lowerRemarks.includes('flight') || lowerRemarks.includes('metro')) {
            category = 'Travel';
          }

          // Clean title:
          let title = rawRemarks;
          if (title.toUpperCase().startsWith('UPI/')) {
            const parts = title.split('/');
            if (parts.length > 1) {
              title = parts[1];
            }
          }
          title = title.trim();

          parsedTxns.push({
            id: Date.now() + i,
            userId: req.user.id, // ownership stamp for Excel-parsed transactions
            title: title || 'Bank Transaction',
            amount,
            date: dateStr,
            type,
            category
          });
        }

        if (parsedTxns.length > 0) {
          transactions = [...parsedTxns, ...transactions];
          saveTransactions();
          return res.json({ success: true, count: parsedTxns.length, transactions: parsedTxns });
        }
      }

      return res.status(400).json({ error: 'Could not parse transactions from Excel. Make sure it is a valid bank statement.' });
    } catch (excelErr) {
      console.error('Error parsing Excel:', excelErr);
      return res.status(500).json({ error: 'Failed to parse Excel statement.' });
    }
  }

  // Handle standard txt/csv text statements
  if (req.file) {
    try {
      statementText = req.file.buffer.toString('utf8');
    } catch (err) {
      console.error('Error reading text file from buffer:', err);
      return res.status(500).json({ error: 'Failed to read statement file.' });
    }
  } else if (req.body.text) {
    statementText = req.body.text;
  } else {
    return res.status(400).json({ error: 'No statement text or file provided.' });
  }

  if (!statementText.trim()) {
    return res.status(400).json({ error: 'Statement content is empty.' });
  }

  console.log('Parsing statement. Length:', statementText.length);

  // If Groq is configured, use it for parsing
  if (isGroqConfigured()) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [
            {
              role: 'system',
              content: `You are an expert financial tool. Parse the bank statement or transaction logs provided by the user.
Extract all transactions and return ONLY a JSON array of objects. Do not write any markdown codeblocks, notes, or HTML.
Each transaction object MUST have:
1. "title": Description of transaction (e.g. "Walmart", "Gas Station", "Salary").
2. "amount": A number (negative for debit/expense/withdrawals, positive for credit/deposit/income).
3. "date": Date in YYYY-MM-DD format (if year is not provided, assume 2026).
4. "type": Either "income" or "expense".
5. "category": A single category name (e.g. "Salary", "Shopping", "Food", "Bills", "Investment", "Entertainment", "Travel", "General").

Return only the valid JSON array, like: [{"title": "Salary", "amount": 50000, "date": "2026-05-01", "type": "income", "category": "Salary"}]`
            },
            {
              role: 'user',
              content: statementText
            }
          ],
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json();
        let reply = data.choices[0].message.content.trim();
        
        if (reply.startsWith('```')) {
          reply = reply.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        }

        const parsed = JSON.parse(reply);
        if (Array.isArray(parsed)) {
          const newTxns = parsed.map((txn, index) => ({
            id: Date.now() + index,
            userId: req.user.id, // ownership stamp for AI-parsed transactions
            title: txn.title || 'Unlabeled Transaction',
            amount: parseFloat(txn.amount) || 0,
            date: txn.date || new Date().toISOString().split('T')[0],
            type: txn.type || (txn.amount > 0 ? 'income' : 'expense'),
            category: txn.category || 'General'
          }));
          
          transactions = [...newTxns, ...transactions];
          saveTransactions();
          return res.json({ success: true, count: newTxns.length, transactions: newTxns });
        }
      } else {
        const errText = await response.text();
        console.error('Groq API Error during parsing:', errText);
      }
    } catch (err) {
      console.error('Error invoking Groq API for parsing:', err);
    }
  }

  // Fallback Rule-Based Parser (if Groq is not configured or fails)
  console.log('Using rule-based parser fallback');
  try {
    const lines = statementText.split('\n');
    const parsedTxns = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const dateMatch = line.match(/(\d{4}[-/]\d{2}[-/]\d{2})|(\d{2}[-/]\d{2}[-/]\d{4})|((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})/i);
      const amountMatches = line.match(/[-+]?\d+[\d,]*\.\d{2}|[-+]?\d+[\d,]*/g);
      
      if (dateMatch && amountMatches && amountMatches.length > 0) {
        let amountStr = amountMatches[amountMatches.length - 1];
        let amount = parseFloat(amountStr.replace(/,/g, ''));
        
        let title = line.replace(dateMatch[0], '').replace(amountStr, '').replace(/INR|Rs\.?|₹/g, '').trim();
        title = title.replace(/^[\s,;-|]+|[\s,;-|]+$/g, '');
        
        if (!title) title = 'Bank Transaction';
        
        let type = 'expense';
        if (line.toLowerCase().includes('cr') || line.toLowerCase().includes('deposit') || line.toLowerCase().includes('credit') || amount > 0) {
          type = 'income';
          amount = Math.abs(amount);
        } else {
          amount = -Math.abs(amount);
        }
        
        let date = new Date().toISOString().split('T')[0];
        if (dateMatch[1]) date = dateMatch[1].replace(/\//g, '-');
        else if (dateMatch[2]) {
          const parts = dateMatch[2].split(/[-/]/);
          date = `${parts[2]}-${parts[1]}-${parts[0]}`;
        }
        
        let category = 'General';
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.includes('amazon') || lowerTitle.includes('flipkart') || lowerTitle.includes('shop')) category = 'Shopping';
        else if (lowerTitle.includes('coffee') || lowerTitle.includes('restaurant') || lowerTitle.includes('zomato') || lowerTitle.includes('swiggy') || lowerTitle.includes('food')) category = 'Food';
        else if (lowerTitle.includes('salary') || lowerTitle.includes('deposit') || lowerTitle.includes('paycheck')) category = 'Salary';
        else if (lowerTitle.includes('netflix') || lowerTitle.includes('spotify') || lowerTitle.includes('hotstar')) category = 'Entertainment';
        else if (lowerTitle.includes('dividend') || lowerTitle.includes('stock') || lowerTitle.includes('mutual')) category = 'Investment';
        else if (lowerTitle.includes('bill') || lowerTitle.includes('electricity') || lowerTitle.includes('recharge')) category = 'Bills';

        parsedTxns.push({
          id: Date.now() + i,
          userId: req.user.id, // ownership stamp for rule-based-parsed transactions
          title,
          amount,
          date,
          type,
          category
        });
      }
    }

    if (parsedTxns.length > 0) {
      transactions = [...parsedTxns, ...transactions];
      saveTransactions();
      return res.json({ 
        success: true, 
        count: parsedTxns.length, 
        transactions: parsedTxns,
        notice: 'Parsed using local backup engine' 
      });
    }

    res.status(400).json({ error: 'Could not parse any transactions from the provided statement. Check the format.' });
  } catch (err) {
    console.error('Error parsing file locally:', err);
    res.status(500).json({ error: 'Failed parsing bank statement' });
  }
});

// 5. POST /api/chat
app.post('/api/chat', authenticate, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  // Scope financial context to the authenticated user only.
  // The global transactions array is never sent to the AI.
  const userTransactions = transactions.filter(t => t.userId === req.user.id);

  // Calculate current metrics to provide as context
  const totalIncome = userTransactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  const totalExpenses = userTransactions.filter(t => t.amount < 0).reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const netWorth = 4500000 + (totalIncome - totalExpenses); // base ₹45,50,000 + delta
  const liabilities = 2450000;

  const currentContext = {
    netWorth,
    monthlyIncome: totalIncome,
    monthlyExpenses: totalExpenses,
    liabilities,
    transactionCount: userTransactions.length,
    recentTransactions: userTransactions.slice(0, 10)
  };

  const systemMessage = {
    role: 'system',
    content: `You are FinFlow AI assistant, a helpful financial advisor bot. 
The user is viewing their financial dashboard. 

Here is their LIVE financial context:
- Total Net Worth: ₹${currentContext.netWorth.toLocaleString('en-IN')}
- Monthly Income: ₹${currentContext.monthlyIncome.toLocaleString('en-IN')}
- Monthly Expenses: ₹${currentContext.monthlyExpenses.toLocaleString('en-IN')}
- Active Liabilities: ₹${currentContext.liabilities.toLocaleString('en-IN')}
- Credit Score: 785 out of 850 (Rating: Excellent, Linked to PAN, updated 2 days ago)
- Savings Goals:
  1. Emergency Fund: ₹3,00,000 funded of ₹5,00,000 target (60% completed)
  2. Europe Trip: ₹1,50,000 funded of ₹3,50,000 target (43% completed, Europe Trip is looking very achievable!)
- Portfolio Distribution: Mutual Funds (60%), Direct Stocks (40%)
- Live Transactions (Latest first): ${JSON.stringify(currentContext.recentTransactions)}

Guidelines:
1. Always base your replies on the above live data. When asked about spending, credit score, savings goals, or net worth, refer to their real numbers.
2. Be brief, professional, and friendly. Use relevant emojis.
3. Suggest concrete advice if they are spending too much or have low balance.
4. Let the user know they can update transactions by manual entry or parsing bank statements.

Keep responses under 3-4 sentences if possible, unless a detailed breakdown is requested.`
  };

  const fullMessages = [systemMessage, ...messages];

  if (isGroqConfigured()) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: fullMessages,
          temperature: 0.7,
          max_tokens: 500
        })
      });

      if (response.ok) {
        const data = await response.json();
        const reply = data.choices[0].message.content;
        return res.json({ reply });
      } else {
        const errText = await response.text();
        console.error('Groq API Error:', errText);
      }
    } catch (err) {
      console.error('Error calling Groq API:', err);
    }
  }

  // Fallback chatbot responses (if Groq is not configured or fails)
  console.log('Using fallback chatbot response');
  const userMessage = messages[messages.length - 1].content.toLowerCase();
  let reply = '';

  if (userMessage.includes('hello') || userMessage.includes('hi')) {
    reply = `Hi there! 👋 I am your FinFlow AI assistant. How can I assist you with your budget or transactions today?`;
  } else if (userMessage.includes('credit score') || userMessage.includes('credit')) {
    reply = `Your credit score is 785 out of 850, which is rated as Excellent! 📈 Keep maintaining good financial habits and managing your liabilities to keep it high.`;
  } else if (userMessage.includes('goal') || userMessage.includes('saving') || userMessage.includes('europe') || userMessage.includes('emergency')) {
    reply = `You currently have two savings goals:
1. Emergency Fund: ₹3,00,000 funded of ₹5,00,000 target (60% completed)
2. Europe Trip: ₹1,50,000 funded of ₹3,50,000 target (43% completed, looking very achievable!) ✈️`;
  } else if (userMessage.includes('portfolio') || userMessage.includes('mutual') || userMessage.includes('stock')) {
    reply = `Your portfolio distribution is divided into Mutual Funds (60%) and Direct Stocks (40%). 📊`;
  } else if (userMessage.includes('net worth') || userMessage.includes('wealth') || userMessage.includes('balance')) {
    reply = `Based on your live calculations, your Total Net Worth is ₹${currentContext.netWorth.toLocaleString('en-IN')}. This is calculated from your base net worth plus your active transactions! 💰`;
  } else if (userMessage.includes('spend') || userMessage.includes('expense') || userMessage.includes('cost')) {
    reply = `You have spent a total of ₹${currentContext.monthlyExpenses.toLocaleString('en-IN')} recently. Your transactions show shopping, coffee, and bills. Try to keep an eye on non-essential expenditures! 📉`;
  } else if (userMessage.includes('income') || userMessage.includes('salary') || userMessage.includes('earn')) {
    reply = `Your recent income sums up to ₹${currentContext.monthlyIncome.toLocaleString('en-IN')}. This includes your salary and other dividend gains! 💵`;
  } else if (userMessage.includes('statement') || userMessage.includes('upload') || userMessage.includes('parse')) {
    reply = `You can easily parse bank statements by going to the 'All Transactions' tab, pasting your bank statement logs, or uploading a statement text file! I'll auto-extract all of them. 📂`;
  } else {
    // Pick a random recent transaction to talk about (scoped to the authenticated user)
    const randomTx = userTransactions[Math.floor(Math.random() * userTransactions.length)];
    const txDetail = randomTx ? `For example, I see a recent transaction for "${randomTx.title}" of ₹${Math.abs(randomTx.amount).toLocaleString('en-IN')}.` : '';
    reply = `I can help you review your finances! ${txDetail} Ask me about your net worth, recent expenses, or how to import statements! 💡`;
  }

  res.json({ reply });
});

// 6. GET /api/ml/analyze — proxies full ML analysis to Python microservice
app.get('/api/ml/analyze', authenticate, async (req, res) => {
  try {
    // Scope ML analysis to the authenticated user's transactions only.
    const userTransactions = transactions.filter(t => t.userId === req.user.id);
    const payload = {
      transactions: userTransactions,
      liabilities: 2450000,
      base_net_worth: 4500000,
      emergency_fund: 300000,
      emergency_target: 500000,
      n_forecast_months: 3
    };

    const mlRes = await fetch(`${ML_SERVICE_URL}/ml/full-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!mlRes.ok) {
      const errText = await mlRes.text();
      console.error('ML Service Error:', errText);
      return res.status(502).json({ error: 'ML service returned an error', detail: errText });
    }

    const mlData = await mlRes.json();
    res.json(mlData);
  } catch (err) {
    console.error('Failed to reach ML service:', err.message);
    res.status(503).json({
      error: 'ML service unavailable',
      detail: 'Make sure the Python ML service is running on port 8000 (npm run start-ml)'
    });
  }
});

// 7. POST /api/plan-chat — LLM narrates ML results only (strict narrate-only prompt)
// Authentication is enforced. mlContext is client-provided state derived from /api/ml/analyze
// (which is now scoped to the authenticated user). Full server-side re-validation of mlContext
// is a follow-up task (tracked separately; a redesign of the plan-chat architecture is required).
app.post('/api/plan-chat', authenticate, async (req, res) => {
  const { messages, mlContext } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  // Build a tightly constrained system prompt from ML data
  const health = mlContext?.health || {};
  const forecast = mlContext?.forecast || {};
  const anomalies = mlContext?.anomalies || {};
  const clusters = mlContext?.clusters || {};
  const plan = mlContext?.plan || {};

  const healthScore = health.composite_score ?? 'N/A';
  const healthGrade = health.grade?.grade ?? 'N/A';
  const savingsRate = health.ratios?.savings_rate?.value ?? 'N/A';
  const dti = health.ratios?.dti?.value ?? 'N/A';
  const emergencyMonths = health.ratios?.emergency_coverage?.value ?? 'N/A';

  const incomeTrend = forecast.insights?.income_momentum ?? 'unknown';
  const expenseTrend = forecast.insights?.expense_momentum ?? 'unknown';
  const projectedSavings = forecast.insights?.projected_savings_3m ?? 'N/A';

  const anomalyCount = anomalies.total_flagged ?? 0;
  const topAnomaly = anomalies.anomalies?.[0]?.title ?? 'None';

  const dominantCluster = clusters.insights?.dominant_cluster ?? 'unknown';
  const planSteps = (plan.steps || []).map((s, i) => `${i+1}. [${s.priority.toUpperCase()}] ${s.title}: ${s.description}`).join('\n');

  const systemPrompt = `You are the FinFlow AI Plan Advisor. Your ONLY job is to NARRATE and EXPLAIN the results 
produced by our ML models to the user in a conversational way. You must NOT invent, assume, 
or generate any financial analysis yourself — all numbers come from our ML pipeline.

Here are the EXACT ML model outputs you must narrate:

=== FINANCIAL HEALTH SCORER (Rule-Based Ratio Engine) ===
- Composite Score: ${healthScore}/100 (Grade: ${healthGrade})
- Savings Rate: ${savingsRate}%  (benchmark: ≥20%)
- Debt-to-Income: ${dti}%  (benchmark: ≤36%)
- Emergency Coverage: ${emergencyMonths} months (benchmark: ≥6 months)
- Strengths: ${(health.strengths || []).join(', ') || 'None identified'}
- Weaknesses: ${(health.weaknesses || []).join(', ') || 'None identified'}

=== LINEAR REGRESSION FORECASTER ===
- Income Trend: ${incomeTrend}
- Expense Trend: ${expenseTrend}
- Projected Net Savings (next 3 months): ₹${projectedSavings}

=== ISOLATION FOREST ANOMALY DETECTOR ===
- Transactions Flagged: ${anomalyCount}
- Most Anomalous: "${topAnomaly}"

=== K-MEANS SPENDING CLUSTER ===
- Dominant Behaviour Cluster: ${dominantCluster}
- High-Value Exposure: ${clusters.insights?.high_value_exposure_pct ?? 'N/A'}%

=== RULE-BASED PLAN GENERATOR OUTPUT ===
${planSteps || 'No plan steps generated.'}

Guidelines:
1. ONLY discuss the above ML-computed numbers. Never say "I think" or invent figures.
2. When explaining a step, say which ML model found it (e.g., "Our Isolation Forest flagged...").
3. Be conversational, encouraging, and specific. Use ₹ for amounts.
4. Keep responses concise (2–4 sentences) unless asked for detail.
5. If asked something not in the ML output, say: "That falls outside what our ML models analysed in this run."`;

  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  if (isGroqConfigured()) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: fullMessages,
          temperature: 0.4,
          max_tokens: 600
        })
      });

      if (response.ok) {
        const data = await response.json();
        return res.json({ reply: data.choices[0].message.content });
      }
    } catch (err) {
      console.error('Groq plan-chat error:', err);
    }
  }

  // Fallback: summarise plan without LLM
  const fallbackReply = plan.plan_summary
    ? `${plan.plan_summary} The ML models identified ${plan.step_count || 0} action items for you.`
    : 'ML analysis complete. Please configure Groq API key for AI narration.';
  res.json({ reply: fallbackReply });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (isGroqConfigured()) {
    console.log('Groq API Key is loaded successfully.');
  } else {
    console.log('Groq API Key is NOT configured or is default. Running in Demo mode with smart local fallbacks.');
  }
});
