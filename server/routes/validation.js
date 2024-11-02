import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse';
import { createReadStream, unlinkSync } from 'fs';
import { validateEmail } from '../validators/email.js';

const router = express.Router();

// Configure multer with limits and file filter
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 50 * 1024 * 1024, // Increased to 50MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      cb(new Error('Only CSV files are allowed'));
      return;
    }
    cb(null, true);
  }
});

// Single email validation endpoint
router.post('/validate', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        valid: false,
        reason: 'Email is required'
      });
    }

    const result = await validateEmail(email);
    return res.json(result);
  } catch (error) {
    console.error('Validation error:', error);
    return res.status(500).json({
      valid: false,
      reason: process.env.NODE_ENV === 'production' 
        ? 'Server error occurred' 
        : error.message
    });
  }
});

// Bulk validation endpoint with improved streaming
router.post('/validate/bulk', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ 
      type: 'error',
      error: 'CSV file is required' 
    });
  }

  // Set headers for streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Increase timeouts
  req.setTimeout(3600000); // 1 hour
  res.setTimeout(3600000); // 1 hour

  let cleanup = true;

  try {
    // First pass: count total records
    let totalRecords = 0;
    let headers = [];
    
    await new Promise((resolve, reject) => {
      const countParser = parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      createReadStream(req.file.path)
        .pipe(countParser)
        .on('data', (record) => {
          if (totalRecords === 0) {
            headers = Object.keys(record);
          }
          totalRecords++;
        })
        .on('error', reject)
        .on('end', resolve);
    });

    if (totalRecords === 0) {
      throw new Error('CSV file is empty');
    }

    // Send initial headers and total count
    res.write(`data: ${JSON.stringify({
      type: 'init',
      totalRecords,
      headers: [
        ...headers,
        'validation_result',
        'validation_reason',
        'mx_check',
        'dns_check',
        'spf_check',
        'mailbox_check',
        'smtp_check'
      ]
    })}\n\n`);

    // Second pass: process records with chunking
    const CHUNK_SIZE = 5; // Process 5 emails at a time
    let currentChunk = [];
    let processedCount = 0;

    const processChunk = async (records) => {
      const results = await Promise.all(
        records.map(async (record) => {
          const email = record.email || record.Email || record.EMAIL;
          
          try {
            if (!email) {
              return {
                ...record,
                validation_result: 'Invalid',
                validation_reason: 'No email address found',
                mx_check: false,
                dns_check: false,
                spf_check: false,
                mailbox_check: false,
                smtp_check: false
              };
            }

            const validationResult = await validateEmail(email);
            
            return {
              ...record,
              validation_result: validationResult.valid ? 'Valid' : 'Invalid',
              validation_reason: validationResult.reason || 'Unknown validation status',
              mx_check: validationResult.checks?.mx || false,
              dns_check: validationResult.checks?.dns || false,
              spf_check: validationResult.checks?.spf || false,
              mailbox_check: validationResult.checks?.mailbox || false,
              smtp_check: validationResult.checks?.smtp || false
            };
          } catch (error) {
            return {
              ...record,
              validation_result: 'Invalid',
              validation_reason: 'Processing error: ' + (error.message || 'Unknown error'),
              mx_check: false,
              dns_check: false,
              spf_check: false,
              mailbox_check: false,
              smtp_check: false
            };
          }
        })
      );

      return results;
    };

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    await new Promise((resolve, reject) => {
      createReadStream(req.file.path)
        .pipe(parser)
        .on('data', async (record) => {
          currentChunk.push(record);
          
          if (currentChunk.length >= CHUNK_SIZE) {
            parser.pause();
            
            try {
              const results = await processChunk(currentChunk);
              processedCount += results.length;
              
              // Send chunk results and progress
              res.write(`data: ${JSON.stringify({
                type: 'progress',
                progress: (processedCount / totalRecords) * 100,
                results
              })}\n\n`);

              // Send keepalive
              res.write(': keepalive\n\n');
              
              currentChunk = [];
              parser.resume();
            } catch (error) {
              console.error('Chunk processing error:', error);
              processedCount += currentChunk.length;
              currentChunk = [];
              parser.resume();
            }
          }
        })
        .on('error', reject)
        .on('end', async () => {
          // Process remaining records
          if (currentChunk.length > 0) {
            try {
              const results = await processChunk(currentChunk);
              processedCount += results.length;
              
              res.write(`data: ${JSON.stringify({
                type: 'progress',
                progress: 100,
                results
              })}\n\n`);
            } catch (error) {
              console.error('Final chunk processing error:', error);
            }
          }

          // Send completion message
          res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
          resolve();
        });
    });

    res.end();
  } catch (error) {
    console.error('Bulk validation error:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: process.env.NODE_ENV === 'production'
        ? 'Failed to process CSV file'
        : error.message
    })}\n\n`);
    res.end();
  } finally {
    // Cleanup uploaded file
    if (cleanup && req.file?.path) {
      try {
        unlinkSync(req.file.path);
      } catch (error) {
        console.error('Failed to cleanup uploaded file:', error);
      }
    }
  }
});

export default router;