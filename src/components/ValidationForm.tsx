import React, { useState } from 'react';
import { EmailInput } from './EmailInput';
import { BulkUpload } from './BulkUpload';
import { ResultsDisplay } from './ResultsDisplay';
import { ValidationResult } from '../types';
import { AlertCircle } from 'lucide-react';

export function ValidationForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<ValidationResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isBulkValidation, setIsBulkValidation] = useState(false);

  const validateSingleEmail = async () => {
    if (!email) return;
    
    setLoading(true);
    setError(null);
    setResults([]);
    setIsBulkValidation(false);
    
    try {
      const response = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const result = await response.json();
      
      const transformedResult: ValidationResult = {
        email,
        validation_result: result.valid ? 'Valid' : 'Invalid',
        validation_reason: result.reason || 'Unknown validation status',
        mx_check: result.checks?.mx || false,
        dns_check: result.checks?.dns || false,
        spf_check: result.checks?.spf || false,
        mailbox_check: result.checks?.mailbox || false,
        smtp_check: result.checks?.smtp || false
      };
      
      setResults([transformedResult]);
    } catch (error) {
      console.error('Validation error:', error);
      setError(error instanceof Error ? error.message : 'Failed to validate email');
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = async (file: File) => {
    if (!file) return;

    setLoading(true);
    setProgress(0);
    setError(null);
    setResults([]);
    setIsBulkValidation(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/validate/bulk', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const eventSource = new EventSource('/api/validate/bulk');
      let accumulatedResults: ValidationResult[] = [];

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case 'init':
              // Initialize with total count and headers
              break;

            case 'progress':
              setProgress(data.progress);
              if (data.results) {
                accumulatedResults = [...accumulatedResults, ...data.results];
                setResults(accumulatedResults);
              }
              break;

            case 'complete':
              eventSource.close();
              setLoading(false);
              break;

            case 'error':
              throw new Error(data.error);
          }
        } catch (e) {
          console.error('Error processing server message:', e);
          setError(e instanceof Error ? e.message : 'Failed to process server response');
          eventSource.close();
          setLoading(false);
        }
      };

      eventSource.onerror = (error) => {
        console.error('EventSource error:', error);
        setError('Connection to server lost. Please try again.');
        eventSource.close();
        setLoading(false);
      };
    } catch (error) {
      console.error('Bulk validation error:', error);
      setError(error instanceof Error ? error.message : 'Failed to process CSV file');
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (results.length === 0) return;

    const headers = Array.from(new Set(
      results.flatMap(result => Object.keys(result))
    ));

    const csvContent = [
      headers.join(','),
      ...results.map(result => 
        headers.map(header => {
          const value = result[header];
          if (typeof value === 'string' && value.includes(',')) {
            return `"${value}"`;
          }
          return value ?? '';
        }).join(',')
      )
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `email-validation-results-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 space-y-8">
      <EmailInput
        email={email}
        setEmail={setEmail}
        onValidate={validateSingleEmail}
        loading={loading}
      />
      
      <BulkUpload
        onFileSelect={handleFileSelect}
        loading={loading}
        progress={progress}
      />
      
      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/50 rounded-lg p-4 text-red-400">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {results.length > 0 && !isBulkValidation && (
        <ResultsDisplay
          results={results}
          onDownload={handleDownload}
          showDownload={false}
        />
      )}

      {results.length > 0 && isBulkValidation && (
        <div className="space-y-6">
          <ResultsDisplay
            results={results}
            onDownload={handleDownload}
            showDownload={true}
          />
          
          <div className="flex justify-center">
            <button
              onClick={handleDownload}
              className="flex items-center justify-center w-full max-w-md px-6 py-3 bg-green-600 text-white text-lg font-medium rounded-lg hover:bg-green-700 transition-colors"
            >
              Download Validation Results
            </button>
          </div>
        </div>
      )}
    </div>
  );
}