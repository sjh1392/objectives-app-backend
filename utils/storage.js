// Supabase Storage utility for file uploads
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
// Use service role key for storage operations (has full access)
// Fallback to anon key if service role key not available (limited functionality)
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('⚠️  Supabase Storage not configured. File uploads will not work.');
}

// Create Supabase client with service role key for storage operations
const supabaseStorage = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const BUCKET_NAME = 'logos';
export const MEDIA_BUCKET_NAME = 'media';

/**
 * Initialize the storage bucket (create if it doesn't exist)
 */
export async function initializeStorage() {
  if (!supabaseStorage) {
    console.warn('Supabase Storage not configured');
    return;
  }

  try {
    // Check if bucket exists
    const { data: buckets, error: listError } = await supabaseStorage.storage.listBuckets();
    
    if (listError) {
      console.error('Error listing buckets:', listError);
      return;
    }

    const existingBuckets = buckets?.map(b => b.name) || [];
    
    // Initialize logos bucket
    if (!existingBuckets.includes(BUCKET_NAME)) {
      const { data, error } = await supabaseStorage.storage.createBucket(BUCKET_NAME, {
        public: true,
        fileSizeLimit: 5242880, // 5MB
        allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
      });

      if (error) {
        console.error('Error creating storage bucket:', error);
        console.warn('⚠️  Please create the "logos" bucket manually in Supabase Storage');
      } else {
        console.log('✅ Storage bucket "logos" created successfully');
      }
    } else {
      console.log('✅ Storage bucket "logos" already exists');
    }
    
    // Initialize media bucket for audio/video
    if (!existingBuckets.includes(MEDIA_BUCKET_NAME)) {
      const { data, error } = await supabaseStorage.storage.createBucket(MEDIA_BUCKET_NAME, {
        public: true,
        fileSizeLimit: 52428800, // 50MB for audio/video
        allowedMimeTypes: ['audio/webm', 'audio/mp3', 'audio/wav', 'video/webm', 'video/mp4']
      });

      if (error) {
        console.error('Error creating media bucket:', error);
        console.warn('⚠️  Please create the "media" bucket manually in Supabase Storage');
      } else {
        console.log('✅ Storage bucket "media" created successfully');
      }
    } else {
      console.log('✅ Storage bucket "media" already exists');
    }
  } catch (error) {
    console.error('Error initializing storage:', error);
  }
}

/**
 * Upload a file to Supabase Storage
 * @param {Buffer|File} file - File to upload (Buffer or File object)
 * @param {string} filename - Filename for the uploaded file
 * @param {string} bucket - Bucket name (defaults to 'logos')
 * @param {string} contentType - MIME type (auto-detected if not provided)
 * @returns {Promise<{url: string, path: string}>}
 */
export async function uploadFile(file, filename, bucket = BUCKET_NAME, contentType = null) {
  if (!supabaseStorage) {
    throw new Error('Supabase Storage not configured. Please set SUPABASE_SERVICE_ROLE_KEY.');
  }

  try {
    // Ensure bucket exists
    await initializeStorage();

    // Convert File to Buffer if needed, or use Buffer directly
    let fileBuffer;
    if (Buffer.isBuffer(file)) {
      fileBuffer = file;
    } else if (file instanceof File || (file && file.arrayBuffer)) {
      // Handle File object
      const arrayBuffer = await file.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuffer);
      // Auto-detect content type from File if not provided
      if (!contentType && file instanceof File) {
        contentType = file.type;
      }
    } else {
      throw new Error('Invalid file type. Expected Buffer or File.');
    }

    // Upload file
    const { data, error } = await supabaseStorage.storage
      .from(bucket)
      .upload(filename, fileBuffer, {
        cacheControl: '3600',
        upsert: false,
        contentType: contentType || 'application/octet-stream'
      });

    if (error) {
      throw error;
    }

    // Get public URL
    const { data: urlData } = supabaseStorage.storage
      .from(bucket)
      .getPublicUrl(data.path);

    return {
      url: urlData.publicUrl,
      path: data.path
    };
  } catch (error) {
    console.error('Error uploading file:', error);
    throw error;
  }
}

/**
 * Delete a file from Supabase Storage
 * @param {string} filePath - Path of the file to delete
 * @param {string} bucket - Bucket name (defaults to 'logos', can be 'media')
 */
export async function deleteFile(filePath, bucket = BUCKET_NAME) {
  if (!supabaseStorage) {
    console.warn('Supabase Storage not configured, cannot delete file');
    return;
  }

  try {
    // Extract path from URL if full URL is provided
    let path = filePath;
    if (filePath.includes('/storage/v1/object/public/')) {
      // Extract bucket and path from URL
      const urlParts = filePath.split('/storage/v1/object/public/')[1];
      if (urlParts) {
        const parts = urlParts.split('/');
        // First part is bucket name, rest is path
        const extractedBucket = parts[0];
        const extractedPath = parts.slice(1).join('/');
        // Use extracted bucket if it matches known buckets
        if (extractedBucket === MEDIA_BUCKET_NAME || extractedBucket === BUCKET_NAME) {
          path = extractedPath;
          // Update bucket if it's a media file
          if (extractedBucket === MEDIA_BUCKET_NAME) {
            bucket = MEDIA_BUCKET_NAME;
          }
        } else {
          path = urlParts;
        }
      }
    } else if (filePath.startsWith('/')) {
      // Remove leading slash
      path = filePath.substring(1);
    }

    const { error } = await supabaseStorage.storage
      .from(bucket)
      .remove([path]);

    if (error) {
      console.error('Error deleting file:', error);
    }
  } catch (error) {
    console.error('Error deleting file:', error);
  }
}

/**
 * Get public URL for a file
 * @param {string} filePath - Path of the file
 * @returns {string} Public URL
 */
export function getPublicUrl(filePath) {
  if (!supabaseStorage) {
    return filePath; // Fallback to original path
  }

  // If already a full URL, return as is
  if (filePath.startsWith('http')) {
    return filePath;
  }

  // Extract path from URL if it contains storage path
  let path = filePath;
  if (filePath.includes('/storage/v1/object/public/')) {
    path = filePath.split('/storage/v1/object/public/')[1]?.split('/').slice(1).join('/');
  } else if (filePath.startsWith('/')) {
    path = filePath.substring(1);
  }

  const { data } = supabaseStorage.storage
    .from(BUCKET_NAME)
    .getPublicUrl(path);

  return data.publicUrl;
}

