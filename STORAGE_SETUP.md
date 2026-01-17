# Supabase Storage Setup for Logo Uploads

Logo uploads now use Supabase Storage instead of local file storage. This ensures files persist across deployments and work with multiple server instances.

## Setup Instructions

### 1. Get Your Supabase Service Role Key

1. Go to your [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Go to **Settings** → **API**
4. Copy the **`service_role`** key (⚠️ Keep this secret! It has full access to your project)

### 2. Add Environment Variable

Add this to your `.env` file (local) and deployment platform (production):

```bash
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

**Important:** 
- The service role key has full access to your Supabase project
- Never commit this to version control
- Only use it on the backend server

### 3. Create Storage Bucket (Automatic)

The bucket will be created automatically when the server starts. However, if you prefer to create it manually:

1. Go to **Storage** in your Supabase dashboard
2. Click **New bucket**
3. Name: `logos`
4. **Public bucket**: ✅ Enabled (so logos can be accessed via URL)
5. Click **Create bucket**

### 4. Optional: Set Bucket Policies

For additional security, you can set up RLS policies in Supabase:

1. Go to **Storage** → **Policies** → `logos` bucket
2. Add policies as needed (the bucket is public by default)

## How It Works

1. **Upload**: Files are uploaded to Supabase Storage bucket `logos`
2. **URL**: A public URL is generated and stored in the database
3. **Access**: Logos are accessible via the public URL
4. **Cleanup**: Old logos are automatically deleted when a new one is uploaded

## Migration from Local Storage

If you have existing logos stored locally (`/uploads/logos/`), they will need to be migrated:

1. Old local paths (`/uploads/logos/logo-123.png`) won't work in production
2. The system will try to convert them, but it's best to re-upload logos
3. New uploads will automatically use Supabase Storage

## Troubleshooting

### "Supabase Storage not configured" warning

- Make sure `SUPABASE_SERVICE_ROLE_KEY` is set in your environment variables
- Restart your server after adding the key

### "Bucket does not exist" error

- The bucket should be created automatically on server start
- If not, create it manually in the Supabase dashboard (see step 3 above)
- Make sure the bucket is named exactly `logos` and is public

### Upload fails

- Check that `SUPABASE_SERVICE_ROLE_KEY` is correct
- Verify the bucket exists and is public
- Check file size (5MB limit)
- Check file type (images only: jpeg, jpg, png, gif, webp)

## Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SUPABASE_URL` | Yes | Your Supabase project URL | `https://xxxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Yes | Supabase anonymous key | `eyJhbGc...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (for uploads) | Supabase service role key | `eyJhbGc...` |

## Benefits

✅ **Persistent**: Files survive server restarts and deployments  
✅ **Scalable**: Works with multiple server instances  
✅ **CDN**: Supabase Storage includes CDN for fast global access  
✅ **No extra service**: Uses your existing Supabase account  
✅ **Automatic cleanup**: Old files are deleted when replaced  

