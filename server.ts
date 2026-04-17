import express from 'express';
import { createServer as createViteServer } from 'vite';
import { google } from 'googleapis';
import session from 'express-session';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.set('trust proxy', 1); 

// Configure multer for memory storage - reduce limit to be safer with proxies
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB is plenty for a resized JPEG
});

app.use(express.json({ limit: '1mb' })); 
app.use(express.urlencoded({ limit: '1mb', extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'aqua-scan-secret-key-123',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: 'aqua_session',
  proxy: true, // Required for secure cookies behind a proxy
  cookie: {
    secure: true,
    sameSite: 'none',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Add session logging middleware
app.use((req, res, next) => {
  console.log(`[SESSION_DEBUG] ${req.method} ${req.path} - SessionID: ${req.sessionID} - Authorized: ${!!(req.session as any).authorized}`);
  next();
});

// Service Account Auth
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
  ]
});

// Helper to get or create a folder in Google Drive
async function getOrCreateDriveFolder(drive: any, folderName: string, parentId: string) {
  try {
    // Search for existing folder
    const response = await drive.files.list({
      q: `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (response.data.files && response.data.files.length > 0) {
      return response.data.files[0].id;
    }

    // Create new folder
    const folderMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    };

    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id',
      supportsAllDrives: true,
    });

    return folder.data.id;
  } catch (error) {
    console.error('[DRIVE] Error in getOrCreateDriveFolder:', error);
    throw error;
  }
}

// Auth Endpoints
app.get('/api/auth/status', (req, res) => {
  res.json({ 
    authorized: !!(req.session as any)?.authorized
  });
});

app.post('/api/auth/verify-key', (req, res) => {
  const { key } = req.body;
  const validKey = process.env.ACCESS_KEY || 'my-secret-access-key';
  
  if (key === validKey) {
    (req.session as any).authorized = true;
    console.log('[AUTH] Key verified successfully. SessionID:', req.sessionID);
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid access key' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    res.json({ success: true });
  });
});

// Middleware to protect API routes
const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const headerKey = req.headers['x-access-key'];
  const validKey = process.env.ACCESS_KEY || 'my-secret-access-key';
  const isAuthorized = (req.session as any)?.authorized || headerKey === validKey;

  if (!isAuthorized) {
    console.log('[AUTH] Unauthorized access attempt to:', req.path, 'SessionID:', req.sessionID);
    return res.status(403).json({ 
      error: 'Unauthorized. Access key required.',
      sessionID: req.sessionID
    });
  }
  next();
};

// Logging and Saving Endpoint
app.post('/api/meter/log', requireAuth, upload.single('image'), async (req, res) => {
  console.log('[LOG] Processing meter log request...');
  
  const { reading, label } = req.body;
  const imageFile = req.file;
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  const driveParentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;

  if (!spreadsheetId) {
    console.error('[LOG] Error: GOOGLE_SPREADSHEET_ID is missing');
    return res.status(500).json({ error: 'Spreadsheet ID not configured on server' });
  }

  if (!driveParentFolderId) {
    console.error('[LOG] Error: GOOGLE_DRIVE_PARENT_FOLDER_ID is missing');
    return res.status(500).json({ error: 'Google Drive Parent Folder ID not configured' });
  }

  if (!imageFile) {
    console.error('[LOG] Error: No image file provided in request');
    return res.status(400).json({ error: 'No image file provided' });
  }

  try {
    const now = new Date();
    const timestamp = now.toLocaleString('en-US', { timeZone: 'UTC' });
    const year = now.getFullYear();
    const month = now.toLocaleString('en-US', { month: 'long' });
    const folderName = `${year}-${month}`;

    const drive = google.drive({ version: 'v3', auth });

    // 1. Get or Create Month Folder in Drive
    console.log('[DRIVE] Ensuring folder exists:', folderName);
    const monthFolderId = await getOrCreateDriveFolder(drive, folderName, driveParentFolderId);
    console.log('[DRIVE] Using folder ID:', monthFolderId);

    // 2. Upload Image to Drive (Create or Update)
    const sanitizedLabel = (label || 'unknown').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = `${sanitizedLabel}.jpg`;

    console.log('[DRIVE] Checking if file exists:', fileName);
    const existingFiles = await drive.files.list({
      q: `name = '${fileName}' and '${monthFolderId}' in parents and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    let driveResponse;
    if (existingFiles.data.files && existingFiles.data.files.length > 0) {
      const fileId = existingFiles.data.files[0].id;
      console.log('[DRIVE] File exists, updating:', fileId);
      driveResponse = await drive.files.update({
        fileId: fileId,
        media: {
          mimeType: 'image/jpeg',
          body: Readable.from(imageFile.buffer),
        },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });
    } else {
      console.log('[DRIVE] File does not exist, creating new one');
      driveResponse = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [monthFolderId],
          mimeType: 'image/jpeg',
        },
        media: {
          mimeType: 'image/jpeg',
          body: Readable.from(imageFile.buffer),
        },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });
    }

    const imageUrl = driveResponse.data.webViewLink;
    console.log('[DRIVE] File processed successfully. ID:', driveResponse.data.id, 'Link:', imageUrl);

    // 3. Log to Google Sheets
    console.log('[SHEETS] Appending to spreadsheet:', spreadsheetId);
    const sheets = google.sheets({ version: 'v4', auth });
    
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          timestamp, 
          reading || 'N/A', 
          label || 'N/A', 
          `=HYPERLINK("${imageUrl}", "View Image")`
        ]]
      }
    });

    console.log('[LOG] Successfully appended to spreadsheet');
    res.json({ success: true, driveFileId: driveResponse.data.id, url: imageUrl });
  } catch (error: any) {
    console.error('[LOG] Error logging meter data:', error);
    res.status(500).json({ error: error.message || 'Failed to log data' });
  }
});

// Global Error Handler for JSON/Body-parser errors
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  if (err.status === 413) {
    return res.status(413).json({ error: 'Image too large. Please use a smaller photo.' });
  }
  next(err);
});

// Vite Integration
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    
    // Explicitly handle 404 for api to avoid SPA fallback
    app.use(['/api'], (req, res) => {
      res.status(404).json({ error: 'Resource not found' });
    });

    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
