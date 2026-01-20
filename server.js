import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import supabase from './db.js';
import { dbRun, dbGet, dbAll } from './db-helpers.js';
import { hashPassword, comparePassword, validatePassword } from './utils/password.js';
import { generateToken, generateRandomToken, hashToken } from './utils/jwt.js';
import { sendVerificationEmail, sendInvitationEmail, sendPasswordResetEmail } from './utils/email.js';
import { authenticate, optionalAuthenticate, authorize, requireOrganization, requireAdminOrManager } from './middleware/auth.js';
import { uploadFile, deleteFile, getPublicUrl, initializeStorage } from './utils/storage.js';

// Notification helper functions
async function parseMentions(content) {
  // Extract @mentions from content (format: @Username or @name)
  const mentionRegex = /@([^\s@]+)/g;
  const mentions = [];
  let match;
  
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1].trim());
  }
  
  return mentions;
}

async function getUserIdsFromMentions(mentions) {
  if (!mentions || mentions.length === 0) return [];
  
  // Get all users to match mentions
  const { data: users, error } = await supabase
    .from('users')
    .select('id, name, email');
  
  if (error || !users) return [];
  
  // Match mentions to user IDs (case-insensitive)
  const userIds = [];
  for (const mention of mentions) {
    const user = users.find(u => 
      u.name.toLowerCase() === mention.toLowerCase() ||
      u.email.toLowerCase() === mention.toLowerCase()
    );
    if (user) {
      userIds.push(user.id);
    }
  }
  
  return [...new Set(userIds)]; // Remove duplicates
}

async function createNotification(userId, type, title, message, objectiveId = null, commentId = null, progressUpdateId = null) {
  try {
    const id = uuidv4();
    const { error } = await supabase
      .from('notifications')
      .insert({
        id,
        user_id: userId,
        objective_id: objectiveId,
        comment_id: commentId,
        progress_update_id: progressUpdateId,
        type,
        title,
        message,
        read: false
      });
    
    if (error) {
      console.error('Error creating notification:', error);
      return null;
    }
    
    return id;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
}

async function notifyObjectiveStakeholders(objectiveId, type, title, message, excludeUserId = null, commentId = null, progressUpdateId = null) {
  try {
    // Get objective owner and contributors
    const objective = await dbGet('SELECT owner_id FROM objectives WHERE id = ?', [objectiveId]);
    if (!objective) return;
    
    const { data: contributors } = await supabase
      .from('objective_contributors')
      .select('user_id')
      .eq('objective_id', objectiveId);
    
    // Get subscribers
    const { data: subscriptions } = await supabase
      .from('objective_subscriptions')
      .select('user_id')
      .eq('objective_id', objectiveId);
    
    const userIds = new Set();
    
    // Add owner
    if (objective.owner_id && objective.owner_id !== excludeUserId) {
      userIds.add(objective.owner_id);
    }
    
    // Add contributors
    if (contributors) {
      contributors.forEach(c => {
        if (c.user_id && c.user_id !== excludeUserId) {
          userIds.add(c.user_id);
        }
      });
    }
    
    // Add subscribers
    if (subscriptions) {
      subscriptions.forEach(s => {
        if (s.user_id && s.user_id !== excludeUserId) {
          userIds.add(s.user_id);
        }
      });
    }
    
    // Create notifications for all stakeholders
    const notificationPromises = Array.from(userIds).map(userId =>
      createNotification(userId, type, title, message, objectiveId, commentId, progressUpdateId)
    );
    
    await Promise.all(notificationPromises);
  } catch (error) {
    console.error('Error notifying stakeholders:', error);
  }
}

const app = express();

// Trust proxy for accurate protocol/host detection (needed for production behind load balancers)
app.set('trust proxy', true);
const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure CORS with environment variable support
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000']; // Default to localhost for development

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // In development, allow all origins
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // In production, check against allowed origins
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS: Blocked request from origin: ${origin}. Allowed origins: ${allowedOrigins.join(', ')}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public', 'uploads', 'logos');
    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `logo-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (jpeg, jpg, png, gif, webp) are allowed!'));
    }
  }
});

// Serve static files from public directory
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Test Supabase connection on startup and check for companies table
(async () => {
  try {
    const { error } = await supabase.from('users').select('count').limit(1);
    if (error && error.code !== 'PGRST116') {
      console.error('Error connecting to Supabase:', error.message);
      console.error('Please ensure SUPABASE_URL and SUPABASE_ANON_KEY are set in your .env file');
    } else {
      console.log('Connected to Supabase database');
      
      // Initialize storage bucket
      await initializeStorage();
      
      // Check if companies table exists
      const { error: tableError } = await supabase.from('companies').select('id').limit(1);
      if (tableError && tableError.code === 'PGRST116') {
        console.warn('\n⚠️  Companies table does not exist!');
        console.warn('Please run the migration SQL in your Supabase SQL editor:');
        console.warn('1. Go to your Supabase dashboard');
        console.warn('2. Navigate to SQL Editor');
        console.warn('3. Run the SQL from: backend/migrations/add_company_table.sql\n');
      } else if (tableError) {
        console.warn('Warning: Could not verify companies table. Error:', tableError.message);
      } else {
        console.log('Companies table verified');
      }
    }
  } catch (error) {
    console.error('Failed to connect to Supabase:', error.message);
  }
})();

// Calculate progress for objective based on key results
async function calculateObjectiveProgress(objectiveId) {
  const objective = await dbGet('SELECT * FROM objectives WHERE id = ?', [objectiveId]);
  if (!objective) return 0;

  const keyResults = await dbAll(
    'SELECT * FROM key_results WHERE objective_id = ?',
    [objectiveId]
  );

  if (keyResults.length === 0) {
    // Reset progress if no key results
    const now = new Date().toISOString();
    await supabase
      .from('objectives')
      .update({ 
        progress_percentage: 0, 
        current_value: 0, 
        updated_at: now 
      })
      .eq('id', objectiveId);
    return 0;
  }

  const totalProgress = keyResults.reduce((sum, kr) => sum + (kr.progress_percentage || 0), 0);
  const averageProgress = totalProgress / keyResults.length;

  // Calculate current_value based on progress percentage and target_value
  const targetValue = objective.target_value || 100;
  const currentValue = (averageProgress / 100) * targetValue;

  const now = new Date().toISOString();
  await supabase
    .from('objectives')
    .update({ 
      progress_percentage: averageProgress, 
      current_value: currentValue, 
      updated_at: now 
    })
    .eq('id', objectiveId);

  return averageProgress;
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Objectives API is running' });
});

// Get all objectives with optional filters (organization-scoped)
app.get('/api/objectives', optionalAuthenticate, async (req, res) => {
  try {
    let queryBuilder = supabase.from('objectives').select('*');
    
    // Filter by organization if user is authenticated
    if (req.user && req.user.organizationId) {
      queryBuilder = queryBuilder.eq('organization_id', req.user.organizationId);
    }

    // Apply filters
    if (req.query.status) {
      queryBuilder = queryBuilder.eq('status', req.query.status);
    }

    if (req.query.owner_id) {
      queryBuilder = queryBuilder.eq('owner_id', req.query.owner_id);
    }

    if (req.query.department_id) {
      queryBuilder = queryBuilder.eq('department_id', req.query.department_id);
    }

    if (req.query.tag) {
      // For JSONB, search for tag in array using @> operator via RPC or filter
      // Supabase supports JSONB containment queries
      queryBuilder = queryBuilder.contains('tags', [req.query.tag]);
    }

    // Handle sorting
    const sortBy = req.query.sortBy || 'created_at';
    const sortOrder = req.query.sortOrder || 'DESC';
    const validSortFields = ['created_at', 'updated_at', 'due_date', 'title'];
    const validSortOrders = ['ASC', 'DESC'];
    
    const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'created_at';
    const finalSortOrder = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
    
    queryBuilder = queryBuilder.order(finalSortBy, { ascending: finalSortOrder === 'ASC' });

    // Handle search - this is complex with JOINs, so we'll do it separately if needed
    const isSearchOnly = req.query.search && !req.query.status && !req.query.tag && !req.query.owner_id && !req.query.department_id;
    
    if (isSearchOnly) {
      queryBuilder = queryBuilder.limit(20);
    }

    const { data: objectives, error } = await queryBuilder;
    
    if (error) throw error;

    // Handle search separately if present (requires JOIN with users)
    let filteredObjectives = objectives || [];
    if (req.query.search) {
      const searchTerm = req.query.search.toLowerCase();
      // Get all users for matching
      const { data: allUsers } = await supabase.from('users').select('id, name, email');
      const userIds = new Set();
      if (allUsers) {
        allUsers.forEach(user => {
          if (user.name?.toLowerCase().includes(searchTerm) || 
              user.email?.toLowerCase().includes(searchTerm)) {
            userIds.add(user.id);
          }
        });
      }

      filteredObjectives = (objectives || []).filter(obj => {
        const titleMatch = obj.title?.toLowerCase().includes(searchTerm);
        const descMatch = obj.description?.toLowerCase().includes(searchTerm);
        const ownerMatch = userIds.has(obj.owner_id);
        return titleMatch || descMatch || ownerMatch;
      });
    }
    
    // Only load contributors if not a search query (search results don't need contributors)
    let contributorsMap = {};
    if (!isSearchOnly && filteredObjectives.length > 0) {
      const objectiveIds = filteredObjectives.map(obj => obj.id);
      const { data: contributors } = await supabase
        .from('objective_contributors')
        .select('objective_id, user_id, users(id, name, email)')
        .in('objective_id', objectiveIds);
      
      if (contributors) {
        contributors.forEach(contrib => {
          if (!contributorsMap[contrib.objective_id]) {
            contributorsMap[contrib.objective_id] = [];
          }
          const user = contrib.users;
          if (user) {
            contributorsMap[contrib.objective_id].push({
              id: contrib.user_id,
              name: user.name,
              email: user.email
            });
          }
        });
      }
    }
    
    // Tags are already JSONB arrays, just ensure they're arrays
    const objectivesWithParsedTags = filteredObjectives.map(obj => ({
      ...obj,
      tags: Array.isArray(obj.tags) ? obj.tags : (obj.tags ? JSON.parse(obj.tags) : []),
      contributors: contributorsMap[obj.id] || []
    }));

    res.json(objectivesWithParsedTags);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single objective
app.get('/api/objectives/:id', async (req, res) => {
  try {
    const objective = await dbGet('SELECT * FROM objectives WHERE id = ?', [req.params.id]);
    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' });
    }

    // Tags are JSONB arrays in Supabase
    objective.tags = Array.isArray(objective.tags) ? objective.tags : (objective.tags ? JSON.parse(objective.tags) : []);
    
    // Get contributors using Supabase JOIN
    const { data: contributors } = await supabase
      .from('objective_contributors')
      .select('user_id, users(id, name, email)')
      .eq('objective_id', req.params.id);
    
    objective.contributors = (contributors || []).map(c => ({
      id: c.user_id,
      name: c.users?.name,
      email: c.users?.email
    })).filter(c => c.name); // Filter out any missing user data
    
    res.json(objective);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create objective
app.post('/api/objectives', authenticate, requireOrganization, async (req, res) => {
  try {
    const {
      title,
      description,
      owner_id,
      department_id,
      team_id, // Support team_id as alias for department_id
      parent_objective_id,
      status = 'Active',
      priority = 'Medium',
      start_date,
      due_date,
      target_value,
      current_value,
      tags = []
    } = req.body;

    // Use team_id if provided, otherwise fall back to department_id
    const finalDepartmentId = team_id !== undefined ? team_id : department_id;

    const id = uuidv4();
    // Tags stored as JSONB array in Supabase
    const tagsArray = Array.isArray(tags) ? tags : [];

    // Normalize null/empty values - convert empty strings to null
    const normalizeValue = (val) => {
      if (val === '' || val === undefined) return null;
      return val;
    };

    const insertData = {
      id,
      title: title || '',
      description: normalizeValue(description),
      owner_id: normalizeValue(owner_id),
      department_id: normalizeValue(finalDepartmentId),
      parent_objective_id: normalizeValue(parent_objective_id),
      status: status || 'Active',
      priority: priority || 'Medium',
      start_date: normalizeValue(start_date),
      due_date: normalizeValue(due_date),
      target_value: normalizeValue(target_value),
      current_value: normalizeValue(current_value),
      tags: tagsArray,
      organization_id: req.organizationId
    };

    // Validate required fields
    if (!insertData.title || insertData.title.trim() === '') {
      return res.status(400).json({ error: 'Title is required' });
    }

    if (!insertData.organization_id) {
      console.error('Missing organization_id in request:', {
        userId: req.user?.id,
        userOrgId: req.user?.organizationId,
        reqOrgId: req.organizationId
      });
      return res.status(400).json({ error: 'Organization ID is required' });
    }

    console.log('Creating objective with data:', JSON.stringify(insertData, null, 2));

    const { data: objective, error } = await supabase
      .from('objectives')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Supabase error creating objective:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      throw error;
    }

    // Ensure tags is an array
    objective.tags = Array.isArray(objective.tags) ? objective.tags : [];

    res.status(201).json(objective);
  } catch (error) {
    console.error('Error creating objective:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', req.body);
    console.error('User:', req.user);
    console.error('Organization ID:', req.organizationId);
    
    // Provide more detailed error message
    const errorMessage = error.message || 'Unknown error occurred';
    const errorDetails = error.details || error.hint || '';
    
    res.status(500).json({ 
      error: errorMessage,
      details: errorDetails,
      code: error.code || 'UNKNOWN_ERROR'
    });
  }
});

// Update objective
app.put('/api/objectives/:id', async (req, res) => {
  try {
    const {
      title,
      description,
      owner_id,
      department_id,
      team_id, // Support team_id as alias for department_id
      parent_objective_id,
      status,
      priority,
      start_date,
      due_date,
      target_value,
      current_value,
      tags
    } = req.body;

    // Build update object dynamically
    const updates = {};
    const now = new Date().toISOString();

    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (owner_id !== undefined) updates.owner_id = owner_id;
    // Support both team_id and department_id (team_id takes precedence)
    if (team_id !== undefined) {
      updates.department_id = team_id;
    } else if (department_id !== undefined) {
      updates.department_id = department_id;
    }
    if (parent_objective_id !== undefined) updates.parent_objective_id = parent_objective_id;
    if (status !== undefined) updates.status = status;
    if (priority !== undefined) updates.priority = priority;
    if (start_date !== undefined) updates.start_date = start_date;
    if (due_date !== undefined) updates.due_date = due_date;
    if (target_value !== undefined) updates.target_value = target_value;
    if (current_value !== undefined) updates.current_value = current_value;
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags : [];

    if (status === 'Completed') {
      updates.completed_at = now;
    }

    updates.updated_at = now;

    const { data: objective, error } = await supabase
      .from('objectives')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' });
    }

    // Ensure tags is an array
    objective.tags = Array.isArray(objective.tags) ? objective.tags : [];

    res.json(objective);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete objective
app.delete('/api/objectives/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM objectives WHERE id = ?', [req.params.id]);
    res.json({ message: 'Objective deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update progress
app.patch('/api/objectives/:id/progress', async (req, res) => {
  try {
    const { current_value, notes, user_id } = req.body;
    const objectiveId = req.params.id;

    const objective = await dbGet('SELECT * FROM objectives WHERE id = ?', [objectiveId]);
    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' });
    }

    const previousValue = objective.current_value || 0;
    const targetValue = objective.target_value || 100;
    const newProgress = targetValue > 0 ? (current_value / targetValue) * 100 : 0;
    const now = new Date().toISOString();
    
    // Use provided user_id or fall back to objective owner
    const updateUserId = user_id || objective.owner_id;

    await supabase
      .from('objectives')
      .update({ 
        current_value, 
        progress_percentage: newProgress, 
        updated_at: now 
      })
      .eq('id', objectiveId);

    // Log progress update
    const progressUpdateId = uuidv4();
    await supabase
      .from('progress_updates')
      .insert({
        id: progressUpdateId,
        objective_id: objectiveId,
        user_id: updateUserId,
        previous_value: previousValue,
        new_value: current_value,
        notes: notes || ''
      });

    // Get updater info for notifications
    const { data: updater } = await supabase.from('users').select('name').eq('id', updateUserId).single();
    const updaterName = updater?.name || 'Someone';
    
    // Notify objective owner and contributors (excluding updater)
    await notifyObjectiveStakeholders(
      objectiveId,
      'progress_update',
      `Progress updated on "${objective.title}"`,
      `${updaterName} updated progress on "${objective.title}" from ${previousValue} to ${current_value}`,
      updateUserId,
      null,
      progressUpdateId
    );

    const updatedObjective = await dbGet('SELECT * FROM objectives WHERE id = ?', [objectiveId]);
    updatedObjective.tags = Array.isArray(updatedObjective.tags) ? updatedObjective.tags : (updatedObjective.tags ? JSON.parse(updatedObjective.tags) : []);
    
    res.json(updatedObjective);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Key Results routes
app.get('/api/objectives/:id/key-results', async (req, res) => {
  try {
    const keyResults = await dbAll(
      'SELECT * FROM key_results WHERE objective_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(keyResults);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/objectives/:id/key-results', async (req, res) => {
  try {
    const { title, description, target_value, current_value, unit, due_date, auto_update_progress } = req.body;
    const id = uuidv4();
    const progressPercentage = target_value > 0 ? ((current_value || 0) / target_value) * 100 : 0;
    const autoUpdate = auto_update_progress !== undefined ? Boolean(auto_update_progress) : true;

    const { data: keyResult, error } = await supabase
      .from('key_results')
      .insert({
        id,
        objective_id: req.params.id,
        title,
        description,
        target_value,
        current_value: current_value || 0,
        progress_percentage: progressPercentage,
        unit,
        due_date,
        auto_update_progress: autoUpdate
      })
      .select()
      .single();

    if (error) throw error;

    // Recalculate objective progress
    await calculateObjectiveProgress(req.params.id);

    res.status(201).json(keyResult);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/key-results/:id', async (req, res) => {
  try {
    const { title, description, target_value, current_value, unit, status, due_date, progress_percentage, auto_update_progress } = req.body;
    
    // Get existing key result to use as fallback values
    const existing = await dbGet('SELECT * FROM key_results WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ error: 'Key result not found' });
    }
    
    // Determine target_value (use provided, otherwise existing, otherwise 100)
    const finalTargetValue = target_value !== undefined && target_value !== null ? target_value : (existing.target_value || 100);
    
    // Determine progress_percentage and current_value
    let progressPercentage, finalCurrentValue;
    
    if (progress_percentage !== undefined && progress_percentage !== null) {
      // If progress_percentage is explicitly provided, use it
      progressPercentage = progress_percentage;
      
      // If current_value is also provided, use it; otherwise calculate from progress_percentage
      if (current_value !== undefined && current_value !== null) {
        finalCurrentValue = current_value;
      } else {
        finalCurrentValue = (progressPercentage / 100) * finalTargetValue;
      }
    } else if (current_value !== undefined && current_value !== null) {
      // If only current_value is provided, calculate progress_percentage from it
      finalCurrentValue = current_value;
      progressPercentage = finalTargetValue > 0 ? (current_value / finalTargetValue) * 100 : 0;
    } else {
      // Fallback to existing values
      progressPercentage = existing.progress_percentage || 0;
      finalCurrentValue = existing.current_value || 0;
    }

    // Handle auto_update_progress - convert to boolean for Supabase
    let autoUpdate = true; // default
    if (auto_update_progress !== undefined) {
      autoUpdate = Boolean(auto_update_progress);
    } else if (existing.auto_update_progress !== undefined && existing.auto_update_progress !== null) {
      // Handle both boolean and integer (0/1) from database
      autoUpdate = typeof existing.auto_update_progress === 'boolean' 
        ? existing.auto_update_progress 
        : Boolean(existing.auto_update_progress);
    }

    // Prepare values, handling null/undefined properly
    const updateTitle = title !== undefined && title !== null ? title : existing.title;
    const updateDescription = description !== undefined ? description : existing.description;
    const updateUnit = unit !== undefined && unit !== null ? unit : existing.unit;
    const updateStatus = status !== undefined && status !== null ? status : existing.status;
    const updateDueDate = due_date !== undefined ? due_date : existing.due_date;
    const now = new Date().toISOString();

    // Use Supabase directly for complex UPDATE
    const { data: keyResult, error: updateError } = await supabase
      .from('key_results')
      .update({
        title: updateTitle,
        description: updateDescription,
        target_value: finalTargetValue,
        current_value: finalCurrentValue,
        progress_percentage: progressPercentage,
        unit: updateUnit,
        status: updateStatus,
        due_date: updateDueDate,
        auto_update_progress: autoUpdate,
        updated_at: now
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) throw updateError;
    if (!keyResult) {
      return res.status(404).json({ error: 'Key result not found' });
    }
    
    // Recalculate objective progress
    const objectiveId = keyResult.objective_id;
    await calculateObjectiveProgress(objectiveId);

    res.json(keyResult);
  } catch (error) {
    console.error('Error updating key result:', error);
    console.error('Request body:', req.body);
    console.error('Key result ID:', req.params.id);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/key-results/:id', async (req, res) => {
  try {
    const keyResult = await dbGet('SELECT * FROM key_results WHERE id = ?', [req.params.id]);
    const objectiveId = keyResult?.objective_id;

    await dbRun('DELETE FROM key_results WHERE id = ?', [req.params.id]);

    if (objectiveId) {
      await calculateObjectiveProgress(objectiveId);
    }

    res.json({ message: 'Key result deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all tags for reporting
app.get('/api/tags', async (req, res) => {
  try {
    const { data: objectives } = await supabase
      .from('objectives')
      .select('tags')
      .not('tags', 'is', null);
    
    const allTags = new Set();
    
    (objectives || []).forEach(obj => {
      if (obj.tags) {
        const tags = Array.isArray(obj.tags) ? obj.tags : JSON.parse(obj.tags);
        if (Array.isArray(tags)) {
          tags.forEach(tag => allTags.add(tag));
        }
      }
    });

    res.json(Array.from(allTags).sort());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get statistics by tag
app.get('/api/tags/:tag/stats', async (req, res) => {
  try {
    const { tag } = req.params;
    // Use JSONB containment to find objectives with this tag
    const { data: objectives } = await supabase
      .from('objectives')
      .select('*')
      .contains('tags', [tag]);
    
    const stats = {
      total: (objectives || []).length,
      byStatus: {},
      averageProgress: 0,
      totalProgress: 0
    };

    (objectives || []).forEach(obj => {
      stats.byStatus[obj.status] = (stats.byStatus[obj.status] || 0) + 1;
      stats.totalProgress += obj.progress_percentage || 0;
    });

    stats.averageProgress = (objectives || []).length > 0 ? stats.totalProgress / (objectives || []).length : 0;

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const allObjectives = await dbAll('SELECT * FROM objectives');
    const stats = {
      total: allObjectives.length,
      byStatus: {},
      byPriority: {},
      averageProgress: 0,
      totalProgress: 0,
      completed: 0,
      active: 0
    };

    allObjectives.forEach(obj => {
      stats.byStatus[obj.status] = (stats.byStatus[obj.status] || 0) + 1;
      stats.byPriority[obj.priority] = (stats.byPriority[obj.priority] || 0) + 1;
      stats.totalProgress += obj.progress_percentage || 0;
      if (obj.status === 'Completed') stats.completed++;
      if (obj.status === 'Active') stats.active++;
    });

    stats.averageProgress = allObjectives.length > 0 ? stats.totalProgress / allObjectives.length : 0;

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manager Actions endpoint - objectives needing attention
app.get('/api/dashboard/manager-actions', async (req, res) => {
  try {
    const allObjectives = await dbAll('SELECT * FROM objectives WHERE status != ?', ['Completed']);
    
    // Get progress updates for all objectives
    const progressUpdates = await dbAll('SELECT objective_id, MAX(created_at) as last_update FROM progress_updates GROUP BY objective_id');
    const updatesMap = new Map();
    progressUpdates.forEach(update => {
      updatesMap.set(update.objective_id, update.last_update);
    });

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const noUpdates = [];
    const pastDue = [];

    allObjectives.forEach(obj => {
      // Parse tags if they're stored as JSON string
      if (obj.tags && typeof obj.tags === 'string') {
        try {
          obj.tags = JSON.parse(obj.tags);
        } catch (e) {
          obj.tags = [];
        }
      } else if (!obj.tags) {
        obj.tags = [];
      }

      const lastUpdate = updatesMap.get(obj.id);
      const updatedAt = new Date(obj.updated_at);
      
      // Check if no update in the last 7 days (or never had a progress update)
      const hasRecentUpdate = lastUpdate ? new Date(lastUpdate) > sevenDaysAgo : false;
      const hasRecentActivity = updatedAt > sevenDaysAgo;
      
      if (!hasRecentUpdate && !hasRecentActivity && obj.status !== 'Completed') {
        noUpdates.push(obj);
      }

      // Check if past due date
      if (obj.due_date) {
        const dueDate = new Date(obj.due_date);
        if (dueDate < now && obj.status !== 'Completed') {
          pastDue.push(obj);
        }
      }
    });

    res.json({
      noUpdates,
      pastDue
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Users and Departments
// Update user role (admin only)
app.put('/api/users/:id/role', authenticate, authorize('Admin'), requireOrganization, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    
    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }
    
    const validRoles = ['Admin', 'Manager', 'Team Member', 'Viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Check user exists and is in same organization
    const user = await dbGet(
      'SELECT id, organization_id FROM users WHERE id = ?',
      [id]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.organization_id !== req.organizationId) {
      return res.status(403).json({ error: 'Cannot modify users from other organizations' });
    }
    
    // Prevent removing last admin
    if (role !== 'Admin' && user.role === 'Admin') {
      const adminCount = await dbGet(
        'SELECT COUNT(*) as count FROM users WHERE organization_id = ? AND role = ?',
        [req.organizationId, 'Admin']
      );
      if (adminCount.count <= 1) {
        return res.status(400).json({ error: 'Cannot remove last admin' });
      }
    }
    
    await supabase
      .from('users')
      .update({ role })
      .eq('id', id);
    
    const updatedUser = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
    res.json(updatedUser);
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users', authenticate, requireOrganization, async (req, res) => {
  try {
    // Filter by organization
    const users = await dbAll(
      'SELECT id, email, name, role, department, avatar, created_at, last_login FROM users WHERE organization_id = ? ORDER BY name',
      [req.organizationId]
    );
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/:id', authenticate, requireOrganization, async (req, res) => {
  try {
    // Ensure user is in same organization
    const user = await dbGet(
      'SELECT id, email, name, role, department, avatar, created_at, last_login FROM users WHERE id = ? AND organization_id = ?',
      [req.params.id, req.organizationId]
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', authenticate, requireAdminOrManager, requireOrganization, async (req, res) => {
  try {
    const { email, name, role = 'Team Member', department } = req.body;
    
    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }
    
    // Check if user already exists
    const existingUser = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    const id = uuidv4();

    await dbRun(
      'INSERT INTO users (id, email, name, role, department, organization_id, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, email.toLowerCase(), name, role, department || null, req.organizationId, false]
    );

    const user = await dbGet('SELECT id, email, name, role, department, avatar, created_at FROM users WHERE id = ?', [id]);
    res.status(201).json(user);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.put('/api/users/:id', authenticate, requireOrganization, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, role, department, avatar } = req.body;
    
    // Check user exists and is in same organization
    const user = await dbGet(
      'SELECT id, organization_id, role FROM users WHERE id = ?',
      [id]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.organization_id !== req.organizationId) {
      return res.status(403).json({ error: 'Cannot modify users from other organizations' });
    }
    
    // Only admins can change roles
    if (role !== undefined && role !== user.role) {
      if (req.user.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can change user roles' });
      }
      
      // Prevent removing last admin
      if (role !== 'Admin' && user.role === 'Admin') {
        const adminCount = await dbGet(
          'SELECT COUNT(*) as count FROM users WHERE organization_id = ? AND role = ?',
          [req.organizationId, 'Admin']
        );
        if (adminCount.count <= 1) {
          return res.status(400).json({ error: 'Cannot remove last admin' });
        }
      }
    }
    
    // Users can only update their own profile (except admins)
    if (req.user.id !== id && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Can only update your own profile' });
    }
    
    const updates = [];
    const params = [];
    
    if (email !== undefined) { 
      // Check email not taken by another user
      const emailUser = await dbGet('SELECT id FROM users WHERE email = ? AND id != ?', [email.toLowerCase(), id]);
      if (emailUser) {
        return res.status(400).json({ error: 'Email already in use' });
      }
      updates.push('email = ?'); 
      params.push(email.toLowerCase()); 
    }
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (role !== undefined && req.user.role === 'Admin') { updates.push('role = ?'); params.push(role); }
    if (department !== undefined) { updates.push('department = ?'); params.push(department || null); }
    if (avatar !== undefined) { updates.push('avatar = ?'); params.push(avatar); }

    params.push(id);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    await dbRun(query, params);

    const updatedUser = await dbGet('SELECT id, email, name, role, department, avatar, created_at, last_login FROM users WHERE id = ?', [id]);
    res.json(updatedUser);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.delete('/api/users/:id', authenticate, authorize('Admin'), requireOrganization, async (req, res) => {
  try {
    await dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Contributors endpoints
app.get('/api/objectives/:id/contributors', async (req, res) => {
  try {
    const contributors = await dbAll(
      `SELECT u.id, u.name, u.email 
       FROM objective_contributors oc 
       JOIN users u ON oc.user_id = u.id 
       WHERE oc.objective_id = ?`,
      [req.params.id]
    );
    res.json(contributors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/objectives/:id/contributors', async (req, res) => {
  try {
    const { user_id } = req.body;
    const id = uuidv4();
    
    await dbRun(
      'INSERT INTO objective_contributors (id, objective_id, user_id) VALUES (?, ?, ?)',
      [id, req.params.id, user_id]
    );
    
    const contributor = await dbGet(
      'SELECT u.id, u.name, u.email FROM users u WHERE u.id = ?',
      [user_id]
    );
    
    res.status(201).json(contributor);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ error: 'User is already a contributor' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.delete('/api/objectives/:id/contributors/:userId', async (req, res) => {
  try {
    await dbRun(
      'DELETE FROM objective_contributors WHERE objective_id = ? AND user_id = ?',
      [req.params.id, req.params.userId]
    );
    res.json({ message: 'Contributor removed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/departments', async (req, res) => {
  try {
    const departments = await dbAll('SELECT * FROM departments ORDER BY name');
    res.json(departments);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/departments/:id', async (req, res) => {
  try {
    const department = await dbGet('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    if (!department) {
      return res.status(404).json({ error: 'Department not found' });
    }
    res.json(department);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/departments', async (req, res) => {
  try {
    const { name, description, manager_id } = req.body;
    const id = uuidv4();

    await dbRun(
      'INSERT INTO departments (id, name, description, manager_id) VALUES (?, ?, ?, ?)',
      [id, name, description || null, manager_id || null]
    );

    const department = await dbGet('SELECT * FROM departments WHERE id = ?', [id]);
    res.status(201).json(department);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/departments/:id', async (req, res) => {
  try {
    const { name, description, manager_id } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (manager_id !== undefined) { updates.push('manager_id = ?'); params.push(manager_id || null); }

    params.push(req.params.id);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const query = `UPDATE departments SET ${updates.join(', ')} WHERE id = ?`;
    await dbRun(query, params);

    const department = await dbGet('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    res.json(department);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/departments/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM departments WHERE id = ?', [req.params.id]);
    res.json({ message: 'Department deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Teams endpoints (aliases for departments for backward compatibility)
app.get('/api/teams', async (req, res) => {
  try {
    const teams = await dbAll('SELECT * FROM departments ORDER BY name');
    res.json(teams);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/teams/:id', async (req, res) => {
  try {
    const team = await dbGet('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json(team);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/teams', async (req, res) => {
  try {
    const { name, description, manager_id } = req.body;
    const id = uuidv4();

    await dbRun(
      'INSERT INTO departments (id, name, description, manager_id) VALUES (?, ?, ?, ?)',
      [id, name, description || null, manager_id || null]
    );

    const team = await dbGet('SELECT * FROM departments WHERE id = ?', [id]);
    res.status(201).json(team);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/teams/:id', async (req, res) => {
  try {
    const { name, description, manager_id } = req.body;
    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (manager_id !== undefined) { updates.push('manager_id = ?'); params.push(manager_id || null); }

    params.push(req.params.id);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const query = `UPDATE departments SET ${updates.join(', ')} WHERE id = ?`;
    await dbRun(query, params);

    const team = await dbGet('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    res.json(team);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/teams/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM departments WHERE id = ?', [req.params.id]);
    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Company endpoints
app.get('/api/company', async (req, res) => {
  try {
    const companies = await dbAll('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    if (companies.length === 0) {
      return res.json(null);
    }
    
    // Ensure logo_url is a full URL (convert old local paths to Supabase URLs if needed)
    const company = companies[0];
    if (company.logo_url && company.logo_url.startsWith('/uploads/')) {
      // Old local path - try to get public URL from Supabase Storage
      try {
        company.logo_url = getPublicUrl(company.logo_url);
      } catch (error) {
        console.warn('Could not convert logo URL:', error);
        // Keep original URL or set to null
        company.logo_url = null;
      }
    }
    
    res.json(company);
  } catch (error) {
    if (error.code === 'PGRST116' || error.message.includes('companies') || error.message.includes('relation') || error.message.includes('table')) {
      res.status(500).json({ 
        error: 'Companies table does not exist. Please run the migration: backend/migrations/add_company_table.sql in your Supabase SQL editor' 
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.post('/api/company', async (req, res) => {
  try {
    const { name, description, logo_url } = req.body;
    
    // Check if company already exists
    const existing = await dbAll('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    
    if (existing.length > 0) {
      // Update existing company
      const updates = [];
      const params = [];
      
      if (name !== undefined) { updates.push('name = ?'); params.push(name); }
      if (description !== undefined) { updates.push('description = ?'); params.push(description); }
      if (logo_url !== undefined) { updates.push('logo_url = ?'); params.push(logo_url); }
      
      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(existing[0].id);
      
      const query = `UPDATE companies SET ${updates.join(', ')} WHERE id = ?`;
      await dbRun(query, params);
      
      const company = await dbGet('SELECT * FROM companies WHERE id = ?', [existing[0].id]);
      res.json(company);
    } else {
      // Create new company
      const id = uuidv4();
      await dbRun(
        'INSERT INTO companies (id, name, description, logo_url) VALUES (?, ?, ?, ?)',
        [id, name, description || null, logo_url || null]
      );
      
      const company = await dbGet('SELECT * FROM companies WHERE id = ?', [id]);
      res.status(201).json(company);
    }
  } catch (error) {
    if (error.code === 'PGRST116' || error.message.includes('companies') || error.message.includes('relation') || error.message.includes('table')) {
      res.status(500).json({ 
        error: 'Companies table does not exist. Please run the migration: backend/migrations/add_company_table.sql in your Supabase SQL editor' 
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.put('/api/company', async (req, res) => {
  try {
    const { name, description, logo_url } = req.body;
    
    // Get existing company
    const existing = await dbAll('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    
    if (existing.length === 0) {
      // Create new if doesn't exist
      const id = uuidv4();
      await dbRun(
        'INSERT INTO companies (id, name, description, logo_url) VALUES (?, ?, ?, ?)',
        [id, name, description || null, logo_url || null]
      );
      
      const company = await dbGet('SELECT * FROM companies WHERE id = ?', [id]);
      return res.json(company);
    }
    
    // Update existing
    const updates = [];
    const params = [];
    
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (logo_url !== undefined) { updates.push('logo_url = ?'); params.push(logo_url); }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(existing[0].id);
    
    const query = `UPDATE companies SET ${updates.join(', ')} WHERE id = ?`;
    await dbRun(query, params);
    
    const company = await dbGet('SELECT * FROM companies WHERE id = ?', [existing[0].id]);
    res.json(company);
  } catch (error) {
    if (error.code === 'PGRST116' || error.message.includes('companies') || error.message.includes('relation') || error.message.includes('table')) {
      res.status(500).json({ 
        error: 'Companies table does not exist. Please run the migration: backend/migrations/add_company_table.sql in your Supabase SQL editor' 
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Logo upload endpoint - using Supabase Storage
app.post('/api/company/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Get existing company to update, or create new one
    const existing = await dbAll('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    
    // Delete old logo if exists (from Supabase Storage)
    if (existing.length > 0 && existing[0].logo_url) {
      try {
        await deleteFile(existing[0].logo_url);
      } catch (deleteError) {
        console.warn('Could not delete old logo:', deleteError);
        // Continue even if deletion fails
      }
    }
    
    // Upload to Supabase Storage
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(req.file.originalname);
    const filename = `logo-${uniqueSuffix}${ext}`;
    
    let logoUrl;
    try {
      // Read file buffer
      const fileBuffer = fs.readFileSync(req.file.path);
      const { url } = await uploadFile(fileBuffer, filename);
      logoUrl = url;
      
      // Delete local temp file
      fs.unlinkSync(req.file.path);
    } catch (uploadError) {
      // Clean up local file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      throw new Error(`Failed to upload to storage: ${uploadError.message}`);
    }
    
    if (existing.length > 0) {
      // Update existing company
      await dbRun(
        'UPDATE companies SET logo_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [logoUrl, existing[0].id]
      );
      
      const company = await dbGet('SELECT * FROM companies WHERE id = ?', [existing[0].id]);
      res.json({ logo_url: company.logo_url });
    } else {
      // Create new company with logo
      const id = uuidv4();
      await dbRun(
        'INSERT INTO companies (id, name, logo_url) VALUES (?, ?, ?)',
        [id, 'Company', logoUrl]
      );
      
      const company = await dbGet('SELECT * FROM companies WHERE id = ?', [id]);
      res.json({ logo_url: company.logo_url });
    }
  } catch (error) {
    // Delete uploaded file if there was an error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    if (error.code === 'PGRST116' || error.message.includes('companies') || error.message.includes('relation') || error.message.includes('table')) {
      res.status(500).json({ 
        error: 'Companies table does not exist. Please run the migration: backend/migrations/add_company_table.sql in your Supabase SQL editor' 
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Comments endpoints
app.get('/api/objectives/:id/comments', async (req, res) => {
  try {
    const { data: comments, error } = await supabase
      .from('comments')
      .select('*, users(name, email)')
      .eq('objective_id', req.params.id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    // Set default values for system comments (null user_id)
    const commentsWithDefaults = (comments || []).map(c => ({
      ...c,
      user_name: c.users?.name || 'System',
      user_email: c.users?.email || '',
      users: undefined // Remove nested users object
    }));
    
    res.json(commentsWithDefaults);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/objectives/:id/comments', async (req, res) => {
  try {
    const { user_id, content } = req.body;
    const objectiveId = req.params.id;
    const id = uuidv4();
    
    // Get objective and commenter info for notifications
    const objective = await dbGet('SELECT title, owner_id FROM objectives WHERE id = ?', [objectiveId]);
    const { data: commenter } = await supabase.from('users').select('name').eq('id', user_id).single();
    const commenterName = commenter?.name || 'Someone';
    
    const { data: comment, error: insertError } = await supabase
      .from('comments')
      .insert({
        id,
        objective_id: objectiveId,
        user_id,
        content
      })
      .select()
      .single();
    
    if (insertError) throw insertError;
    
    // Fetch with user details
    const { data: commentWithUser, error: fetchError } = await supabase
      .from('comments')
      .select('*, users(name, email)')
      .eq('id', id)
      .single();
    
    if (fetchError) throw fetchError;
    
    // Format response
    const formattedComment = {
      ...commentWithUser,
      user_name: commentWithUser.users?.name || 'System',
      user_email: commentWithUser.users?.email || ''
    };
    delete formattedComment.users; // Remove nested users object
    
    // Create notifications
    if (objective) {
      // Notify mentioned users
      const mentions = await parseMentions(content);
      if (mentions.length > 0) {
        const mentionedUserIds = await getUserIdsFromMentions(mentions);
        for (const mentionedUserId of mentionedUserIds) {
          if (mentionedUserId !== user_id) {
            await createNotification(
              mentionedUserId,
              'mention',
              `You were mentioned in a comment`,
              `${commenterName} mentioned you in a comment on "${objective.title}"`,
              objectiveId,
              id
            );
          }
        }
      }
      
      // Notify objective owner and contributors (excluding commenter)
      await notifyObjectiveStakeholders(
        objectiveId,
        'comment',
        `New comment on "${objective.title}"`,
        `${commenterName} commented on "${objective.title}"`,
        user_id,
        id
      );
    }
    
    res.status(201).json(formattedComment);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Progress updates endpoint
app.get('/api/objectives/:id/progress-updates', async (req, res) => {
  try {
    const updates = await dbAll(
      `SELECT pu.*, u.name as user_name, u.email as user_email 
       FROM progress_updates pu 
       JOIN users u ON pu.user_id = u.id 
       WHERE pu.objective_id = ? 
       ORDER BY pu.created_at DESC`,
      [req.params.id]
    );
    res.json(updates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to get nested value from object using dot notation
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, prop) => {
    if (current && typeof current === 'object' && prop in current) {
      return current[prop];
    }
    return undefined;
  }, obj);
}

// Helper function to set nested value in object
function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  const lastKey = keys.pop();
  const target = keys.reduce((current, key) => {
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    return current[key];
  }, obj);
  target[lastKey] = value;
}

// Verify webhook HMAC signature
function verifyWebhookSignature(payload, signature, secret) {
  try {
    const hmac = crypto.createHmac('sha256', secret);
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const calculatedSignature = hmac.update(payloadString).digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(calculatedSignature)
    );
  } catch (error) {
    return false;
  }
}

// Apply field mapping to payload
function applyFieldMapping(payload, fieldMapping) {
  if (!fieldMapping) return {};
  
  try {
    const mapping = typeof fieldMapping === 'string' ? JSON.parse(fieldMapping) : fieldMapping;
    const result = {};
    
    for (const [targetField, sourcePath] of Object.entries(mapping)) {
      if (sourcePath.startsWith('payload.')) {
        const path = sourcePath.substring(8); // Remove 'payload.' prefix
        const value = getNestedValue(payload, path);
        if (value !== undefined) {
          result[targetField] = value;
        }
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error applying field mapping:', error);
    return {};
  }
}

// Rate limiting for auth endpoints
// More lenient for development, stricter for production
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 5 : 20, // 5 in production, 20 in development
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting in development for localhost
    return process.env.NODE_ENV !== 'production' && req.ip === '::1';
  }
});

// Authentication endpoints
// Register new user
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name, organizationName } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    
    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.errors.join(', ') });
    }
    
    // Check if user already exists
    const existingUser = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    // Hash password
    const passwordHash = await hashPassword(password);
    
    // Generate verification token
    const verificationToken = generateRandomToken();
    const userId = uuidv4();
    
    // Create organization if this is the first user
    let organizationId;
    const orgCount = await dbGet('SELECT COUNT(*) as count FROM organizations');
    const isFirstUser = !orgCount || orgCount.count === 0;
    
    if (isFirstUser && organizationName) {
      organizationId = uuidv4();
      const orgSlug = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      
      await supabase
        .from('organizations')
        .insert({
          id: organizationId,
          name: organizationName,
          slug: orgSlug
        });
    } else {
      // For existing orgs, get the first one (or require org selection)
      const firstOrg = await dbGet('SELECT id FROM organizations LIMIT 1');
      if (!firstOrg) {
        return res.status(400).json({ error: 'No organization found. Please contact an administrator.' });
      }
      organizationId = firstOrg.id;
    }
    
    // Create user
    const now = new Date().toISOString();
    await supabase
      .from('users')
      .insert({
        id: userId,
        email: email.toLowerCase(),
        name,
        password_hash: passwordHash,
        email_verified: false,
        email_verification_token: verificationToken,
        organization_id: organizationId,
        role: isFirstUser ? 'Admin' : 'Team Member'
      });
    
    // Send verification email
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    await sendVerificationEmail(email, name, verificationToken, baseUrl);
    
    res.status(201).json({
      message: 'Registration successful. Please check your email to verify your account.',
      userId,
      emailVerified: false
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Get user with password hash
    const user = await dbGet(
      'SELECT id, email, name, role, organization_id, password_hash, email_verified FROM users WHERE email = ?',
      [email.toLowerCase()]
    );
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Account not set up. Please use invitation link or reset password.' });
    }
    
    // Verify password
    const passwordValid = await comparePassword(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    if (!user.email_verified) {
      return res.status(403).json({ 
        error: 'Email not verified',
        emailVerified: false,
        userId: user.id
      });
    }
    
    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);
    
    // Generate token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organization_id
    });
    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organization_id
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify email
app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }
    
    const user = await dbGet(
      'SELECT id, email, name FROM users WHERE email_verification_token = ?',
      [token]
    );
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }
    
    // Verify email
    await supabase
      .from('users')
      .update({
        email_verified: true,
        email_verification_token: null
      })
      .eq('id', user.id);
    
    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Resend verification email
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const user = await dbGet(
      'SELECT id, email, name, email_verification_token, email_verified FROM users WHERE email = ?',
      [email.toLowerCase()]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.email_verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }
    
    // Generate new token if needed
    let verificationToken = user.email_verification_token;
    if (!verificationToken) {
      verificationToken = generateRandomToken();
      await supabase
        .from('users')
        .update({ email_verification_token: verificationToken })
        .eq('id', user.id);
    }
    
    // Send verification email
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    await sendVerificationEmail(user.email, user.name, verificationToken, baseUrl);
    
    res.json({ message: 'Verification email sent' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Forgot password
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const user = await dbGet('SELECT id, email, name FROM users WHERE email = ?', [email.toLowerCase()]);
    
    // Don't reveal if user exists or not (security best practice)
    if (user) {
      const resetToken = generateRandomToken();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour expiry
      
      // Store reset token (you might want a separate password_reset_tokens table)
      // For now, we'll use email_verification_token field temporarily
      await supabase
        .from('users')
        .update({ email_verification_token: resetToken })
        .eq('id', user.id);
      
      const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
      await sendPasswordResetEmail(user.email, user.name, resetToken, baseUrl);
    }
    
    res.json({ message: 'If an account exists, a password reset email has been sent' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset password
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }
    
    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.errors.join(', ') });
    }
    
    const user = await dbGet(
      'SELECT id FROM users WHERE email_verification_token = ?',
      [token]
    );
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    
    // Hash new password
    const passwordHash = await hashPassword(password);
    
    // Update password and clear token
    await supabase
      .from('users')
      .update({
        password_hash: passwordHash,
        email_verification_token: null
      })
      .eq('id', user.id);
    
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current user
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await dbGet(
      'SELECT id, email, name, role, organization_id, email_verified, created_at, last_login FROM users WHERE id = ?',
      [req.user.id]
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organization_id,
      emailVerified: user.email_verified,
      createdAt: user.created_at,
      lastLogin: user.last_login
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Logout (client-side token removal, but can add token blacklisting here)
app.post('/api/auth/logout', authenticate, async (req, res) => {
  try {
    // Optionally blacklist token in sessions table
    // For now, just return success (client removes token)
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Objective Subscription endpoints
// Subscribe to an objective
app.post('/api/objectives/:id/subscribe', authenticate, requireOrganization, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check if objective exists and is in same organization
    const objective = await dbGet(
      'SELECT id, title, organization_id FROM objectives WHERE id = ?',
      [id]
    );
    
    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' });
    }
    
    if (objective.organization_id !== req.organizationId) {
      return res.status(403).json({ error: 'Cannot subscribe to objectives from other organizations' });
    }
    
    // Check if already subscribed
    const existing = await dbGet(
      'SELECT id FROM objective_subscriptions WHERE user_id = ? AND objective_id = ?',
      [userId, id]
    );
    
    if (existing) {
      return res.status(400).json({ error: 'Already subscribed to this objective' });
    }
    
    // Create subscription
    const subscriptionId = uuidv4();
    await supabase
      .from('objective_subscriptions')
      .insert({
        id: subscriptionId,
        user_id: userId,
        objective_id: id
      });
    
    // Create a notification for the user that they subscribed to this objective
    await createNotification(
      userId,
      'objective_update',
      'Subscribed to objective',
      `You subscribed to "${objective.title}". You'll receive notifications for updates to this objective.`,
      id
    );
    
    res.status(201).json({ message: 'Subscribed to objective', subscribed: true });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Unsubscribe from an objective
app.delete('/api/objectives/:id/subscribe', authenticate, requireOrganization, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check if subscription exists
    const subscription = await dbGet(
      'SELECT id FROM objective_subscriptions WHERE user_id = ? AND objective_id = ?',
      [userId, id]
    );
    
    if (!subscription) {
      return res.status(404).json({ error: 'Not subscribed to this objective' });
    }
    
    // Delete subscription
    await supabase
      .from('objective_subscriptions')
      .delete()
      .eq('id', subscription.id);
    
    res.json({ message: 'Unsubscribed from objective', subscribed: false });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check subscription status
app.get('/api/objectives/:id/subscribe', authenticate, requireOrganization, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const subscription = await dbGet(
      'SELECT id FROM objective_subscriptions WHERE user_id = ? AND objective_id = ?',
      [userId, id]
    );
    
    res.json({ subscribed: !!subscription });
  } catch (error) {
    console.error('Check subscription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Unsubscribe from all objectives
app.delete('/api/objectives/subscribe/all', authenticate, requireOrganization, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Delete all subscriptions for this user
    const { error } = await supabase
      .from('objective_subscriptions')
      .delete()
      .eq('user_id', userId);
    
    if (error) {
      throw error;
    }
    
    res.json({ message: 'Unsubscribed from all objectives', count: 'all' });
  } catch (error) {
    console.error('Unsubscribe all error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get subscription count for debugging
app.get('/api/objectives/subscriptions/count', authenticate, requireOrganization, async (req, res) => {
  try {
    const userId = req.query.user_id || req.user.id;
    
    // Get subscription count for this user
    const { count, error } = await supabase
      .from('objective_subscriptions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    
    if (error) {
      throw error;
    }
    
    // Also get total objectives count for context
    const totalObjectives = await dbGet(
      'SELECT COUNT(*) as count FROM objectives WHERE organization_id = ?',
      [req.organizationId]
    );
    
    res.json({ 
      subscription_count: count || 0,
      total_objectives: totalObjectives?.count || 0,
      user_id: userId
    });
  } catch (error) {
    console.error('Subscription count error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get objectives that the current user is subscribed to
app.get('/api/objectives/subscribed', authenticate, requireOrganization, async (req, res) => {
  try {
    const userId = req.user.id;
    
    console.log('Fetching subscribed objectives for user:', userId, 'org:', req.organizationId);
    
    // Get all subscriptions for this user using both methods to ensure compatibility
    const { data: subscriptions, error: subError } = await supabase
      .from('objective_subscriptions')
      .select('objective_id')
      .eq('user_id', userId);
    
    if (subError) {
      console.error('Subscription query error:', subError);
      throw subError;
    }
    
    console.log('Found subscriptions:', subscriptions?.length || 0, subscriptions);
    
    if (!subscriptions || subscriptions.length === 0) {
      console.log('No subscriptions found for user:', userId);
      return res.json([]);
    }
    
    const objectiveIds = subscriptions.map(s => s.objective_id);
    console.log('Objective IDs to fetch:', objectiveIds);
    
    // Get objectives using Supabase
    let queryBuilder = supabase
      .from('objectives')
      .select('*')
      .in('id', objectiveIds)
      .eq('organization_id', req.organizationId);
    
    // Apply filters if provided
    if (req.query.status) {
      queryBuilder = queryBuilder.eq('status', req.query.status);
    }
    
    const { data: objectives, error: objError } = await queryBuilder.order('updated_at', { ascending: false });
    
    if (objError) {
      console.error('Objectives query error:', objError);
      throw objError;
    }
    
    console.log('Found objectives:', objectives?.length || 0);
    
    // Ensure tags is an array for each objective
    const objectivesWithTags = (objectives || []).map(obj => ({
      ...obj,
      tags: Array.isArray(obj.tags) ? obj.tags : (obj.tags ? JSON.parse(obj.tags) : [])
    }));
    
    res.json(objectivesWithTags);
  } catch (error) {
    console.error('Error fetching subscribed objectives:', error);
    res.status(500).json({ error: error.message });
  }
});

// Notifications endpoints
app.get('/api/notifications', async (req, res) => {
  try {
    const userId = req.query.user_id;
    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    
    const limit = parseInt(req.query.limit) || 50;
    const unreadOnly = req.query.unread_only === 'true';
    
    let query = supabase
      .from('notifications')
      .select('*, objectives(title)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (unreadOnly) {
      query = query.eq('read', false);
    }
    
    const { data: notifications, error } = await query;
    
    if (error) throw error;
    
    // Format notifications
    const formattedNotifications = (notifications || []).map(n => ({
      ...n,
      objective_title: n.objectives?.title || null,
      objectives: undefined // Remove nested object
    }));
    
    res.json(formattedNotifications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/notifications/unread-count', async (req, res) => {
  try {
    const userId = req.query.user_id;
    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('read', false);
    
    if (error) throw error;
    
    res.json({ count: count || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', id);
    
    if (error) throw error;
    
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/notifications/mark-all-read', async (req, res) => {
  try {
    const userId = req.body.user_id;
    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);
    
    if (error) throw error;
    
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/notifications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('notifications')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    
    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Invitation endpoints
// Create invitation (admin/manager only)
app.post('/api/invitations', authenticate, requireAdminOrManager, requireOrganization, async (req, res) => {
  try {
    const { email, role } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const inviteRole = role || 'Team Member';
    const validRoles = ['Admin', 'Manager', 'Team Member', 'Viewer'];
    if (!validRoles.includes(inviteRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Check if user already exists
    const existingUser = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    // Check if invitation already exists
    const existingInvitation = await dbGet(
      'SELECT id FROM invitations WHERE email = ? AND organization_id = ? AND status = ?',
      [email.toLowerCase(), req.organizationId, 'pending']
    );
    if (existingInvitation) {
      return res.status(400).json({ error: 'Invitation already sent to this email' });
    }
    
    // Generate invitation token
    const token = generateRandomToken();
    const invitationId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry
    
    // Create invitation
    await supabase
      .from('invitations')
      .insert({
        id: invitationId,
        email: email.toLowerCase(),
        token,
        organization_id: req.organizationId,
        invited_by: req.user.id,
        role: inviteRole,
        status: 'pending',
        expires_at: expiresAt.toISOString()
      });
    
    // Get organization and inviter info
    const organization = await dbGet('SELECT name FROM organizations WHERE id = ?', [req.organizationId]);
    const inviter = await dbGet('SELECT name FROM users WHERE id = ?', [req.user.id]);
    
    // Send invitation email
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    await sendInvitationEmail(
      email,
      inviter.name,
      organization.name,
      inviteRole,
      token,
      baseUrl
    );
    
    const invitation = await dbGet('SELECT * FROM invitations WHERE id = ?', [invitationId]);
    res.status(201).json({
      ...invitation,
      expires_at: invitation.expires_at
    });
  } catch (error) {
    console.error('Create invitation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get invitation by token
app.get('/api/invitations/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const invitation = await dbGet(
      `SELECT i.*, o.name as organization_name, u.name as inviter_name 
       FROM invitations i
       JOIN organizations o ON i.organization_id = o.id
       JOIN users u ON i.invited_by = u.id
       WHERE i.token = ?`,
      [token]
    );
    
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    
    // Check if expired
    if (new Date(invitation.expires_at) < new Date()) {
      await supabase
        .from('invitations')
        .update({ status: 'expired' })
        .eq('id', invitation.id);
      return res.status(400).json({ error: 'Invitation has expired' });
    }
    
    // Check if already accepted
    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: `Invitation has been ${invitation.status}` });
    }
    
    res.json({
      id: invitation.id,
      email: invitation.email,
      organizationName: invitation.organization_name,
      inviterName: invitation.inviter_name,
      role: invitation.role,
      expiresAt: invitation.expires_at
    });
  } catch (error) {
    console.error('Get invitation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Accept invitation
app.post('/api/invitations/:token/accept', async (req, res) => {
  try {
    const { token } = req.params;
    const { password, name } = req.body;
    
    if (!password || !name) {
      return res.status(400).json({ error: 'Password and name are required' });
    }
    
    // Validate password
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.errors.join(', ') });
    }
    
    // Get invitation
    const invitation = await dbGet(
      'SELECT * FROM invitations WHERE token = ?',
      [token]
    );
    
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    
    // Check if expired
    if (new Date(invitation.expires_at) < new Date()) {
      await supabase
        .from('invitations')
        .update({ status: 'expired' })
        .eq('id', invitation.id);
      return res.status(400).json({ error: 'Invitation has expired' });
    }
    
    // Check if already accepted
    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: `Invitation has been ${invitation.status}` });
    }
    
    // Check if user already exists
    const existingUser = await dbGet('SELECT id FROM users WHERE email = ?', [invitation.email]);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    // Hash password
    const passwordHash = await hashPassword(password);
    const userId = uuidv4();
    
    // Create user
    const now = new Date().toISOString();
    await supabase
      .from('users')
      .insert({
        id: userId,
        email: invitation.email,
        name,
        password_hash: passwordHash,
        email_verified: true, // Invited users are pre-verified
        organization_id: invitation.organization_id,
        invited_by: invitation.invited_by,
        invited_at: now,
        role: invitation.role
      });
    
    // Mark invitation as accepted
    await supabase
      .from('invitations')
      .update({
        status: 'accepted',
        accepted_at: now
      })
      .eq('id', invitation.id);
    
    // Generate token
    const jwtToken = generateToken({
      userId,
      email: invitation.email,
      role: invitation.role,
      organizationId: invitation.organization_id
    });
    
    res.status(201).json({
      token: jwtToken,
      user: {
        id: userId,
        email: invitation.email,
        name,
        role: invitation.role,
        organizationId: invitation.organization_id
      }
    });
  } catch (error) {
    console.error('Accept invitation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List invitations (admin/manager only)
app.get('/api/invitations', authenticate, requireAdminOrManager, requireOrganization, async (req, res) => {
  try {
    const invitations = await dbAll(
      `SELECT i.*, u.name as inviter_name 
       FROM invitations i
       JOIN users u ON i.invited_by = u.id
       WHERE i.organization_id = ?
       ORDER BY i.created_at DESC`,
      [req.organizationId]
    );
    
    res.json(invitations);
  } catch (error) {
    console.error('List invitations error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Cancel invitation
app.delete('/api/invitations/:id', authenticate, requireAdminOrManager, requireOrganization, async (req, res) => {
  try {
    const { id } = req.params;
    
    const invitation = await dbGet(
      'SELECT * FROM invitations WHERE id = ? AND organization_id = ?',
      [id, req.organizationId]
    );
    
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    
    if (invitation.status === 'accepted') {
      return res.status(400).json({ error: 'Cannot cancel accepted invitation' });
    }
    
    await supabase
      .from('invitations')
      .update({ status: 'cancelled' })
      .eq('id', id);
    
    res.json({ message: 'Invitation cancelled' });
  } catch (error) {
    console.error('Cancel invitation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Organization endpoints
// Get user's organization
app.get('/api/organizations', authenticate, requireOrganization, async (req, res) => {
  try {
    const organization = await dbGet(
      'SELECT * FROM organizations WHERE id = ?',
      [req.organizationId]
    );
    
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }
    
    res.json(organization);
  } catch (error) {
    console.error('Get organization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create organization (first user only, or admin)
app.post('/api/organizations', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Organization name is required' });
    }
    
    // Check if user already has an organization
    if (req.user.organizationId) {
      return res.status(400).json({ error: 'User already belongs to an organization' });
    }
    
    const orgId = uuidv4();
    const orgSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    
    // Check if slug is unique
    const existingOrg = await dbGet('SELECT id FROM organizations WHERE slug = ?', [orgSlug]);
    if (existingOrg) {
      return res.status(400).json({ error: 'Organization with this name already exists' });
    }
    
    // Create organization
    await supabase
      .from('organizations')
      .insert({
        id: orgId,
        name,
        slug: orgSlug
      });
    
    // Update user's organization and make them admin
    await supabase
      .from('users')
      .update({
        organization_id: orgId,
        role: 'Admin'
      })
      .eq('id', req.user.id);
    
    const organization = await dbGet('SELECT * FROM organizations WHERE id = ?', [orgId]);
    res.status(201).json(organization);
  } catch (error) {
    console.error('Create organization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update organization (admin only)
app.put('/api/organizations/:id', authenticate, authorize('Admin'), requireOrganization, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    if (id !== req.organizationId) {
      return res.status(403).json({ error: 'Cannot update other organizations' });
    }
    
    if (!name) {
      return res.status(400).json({ error: 'Organization name is required' });
    }
    
    const orgSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    
    // Check if slug is unique (excluding current org)
    const existingOrg = await dbGet('SELECT id FROM organizations WHERE slug = ? AND id != ?', [orgSlug, id]);
    if (existingOrg) {
      return res.status(400).json({ error: 'Organization with this name already exists' });
    }
    
    await supabase
      .from('organizations')
      .update({
        name,
        slug: orgSlug,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);
    
    const organization = await dbGet('SELECT * FROM organizations WHERE id = ?', [id]);
    res.json(organization);
  } catch (error) {
    console.error('Update organization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get organization members
app.get('/api/organizations/members', authenticate, requireOrganization, async (req, res) => {
  try {
    const members = await dbAll(
      'SELECT id, email, name, role, created_at, last_login FROM users WHERE organization_id = ? ORDER BY created_at DESC',
      [req.organizationId]
    );
    
    res.json(members);
  } catch (error) {
    console.error('Get organization members error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook Receiver Endpoint
app.post('/api/webhooks/:webhook_id', async (req, res) => {
  try {
    const webhookId = req.params.webhook_id;
    const payload = req.body;
    const signature = req.headers['x-webhook-signature'] || req.headers['x-hub-signature-256'];
    
    // Get webhook integration
    const webhookIntegration = await dbGet(
      'SELECT * FROM webhook_integrations WHERE id = ?',
      [webhookId]
    );
    
    if (!webhookIntegration) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    
    if (webhookIntegration.status !== 'active') {
      return res.status(403).json({ error: 'Webhook is not active' });
    }
    
    // Verify signature if provided
    if (signature) {
      const secret = webhookIntegration.webhook_secret;
      // Handle GitHub-style signature format: sha256=hexdigest
      const signatureHash = signature.replace('sha256=', '');
      
      if (!verifyWebhookSignature(payload, signatureHash, secret)) {
        await dbRun(
          'UPDATE webhook_integrations SET failure_count = failure_count + 1 WHERE id = ?',
          [webhookId]
        );
        
        await dbRun(
          `INSERT INTO webhook_events (id, webhook_integration_id, payload, headers, processed, error_message)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            webhookId,
            JSON.stringify(payload),
            JSON.stringify(req.headers),
            0,
            'Invalid signature'
          ]
        );
        
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
    
    // Log webhook event
    const eventId = uuidv4();
    await dbRun(
      `INSERT INTO webhook_events (id, webhook_integration_id, payload, headers, processed)
       VALUES (?, ?, ?, ?, ?)`,
      [
        eventId,
        webhookId,
        JSON.stringify(payload),
        JSON.stringify(req.headers),
        0
      ]
    );
    
    // Get objective
    const objective = await dbGet(
      'SELECT * FROM objectives WHERE id = ?',
      [webhookIntegration.objective_id]
    );
    
    if (!objective) {
      await dbRun(
        'UPDATE webhook_events SET processed = 1, error_message = ? WHERE id = ?',
        ['Objective not found', eventId]
      );
      return res.status(404).json({ error: 'Objective not found' });
    }
    
    // Apply field mapping
    const mappedData = applyFieldMapping(payload, webhookIntegration.field_mapping);
    
    // Extract comment from payload if available (support both mapped and direct comment field)
    let webhookComment = null;
    if (mappedData.comment) {
      webhookComment = mappedData.comment;
    } else if (payload.comment) {
      webhookComment = payload.comment;
    } else if (payload.message) {
      webhookComment = payload.message;
    } else if (payload.note || payload.notes) {
      webhookComment = payload.note || payload.notes;
    }
    
    // Update objective based on mapped data
    const updates = {};
    // Track previous values for all fields that might change
    const previousValues = {
      current_value: objective.current_value || 0,
      target_value: objective.target_value || 0,
      progress_percentage: objective.progress_percentage || 0
    };
    
    let valueBefore = previousValues.current_value;
    let valueAfter = valueBefore;
    
    if (mappedData.progress_percentage !== undefined) {
      updates.progress_percentage = Math.max(0, Math.min(100, mappedData.progress_percentage));
    }
    
    if (mappedData.current_value !== undefined) {
      valueAfter = mappedData.current_value;
      updates.current_value = valueAfter;
      
      // Recalculate progress if target_value exists
      if (objective.target_value > 0) {
        updates.progress_percentage = Math.min(100, (valueAfter / objective.target_value) * 100);
      }
    }
    
    if (mappedData.target_value !== undefined) {
      updates.target_value = mappedData.target_value;
      // Recalculate progress
      const current = updates.current_value !== undefined ? updates.current_value : objective.current_value || 0;
      if (mappedData.target_value > 0) {
        updates.progress_percentage = Math.min(100, (current / mappedData.target_value) * 100);
      }
    }
    
    // Apply updates if any
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const updateFields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
      const updateValues = Object.values(updates);
      updateValues.push(webhookIntegration.objective_id);
      
      await dbRun(
        `UPDATE objectives SET ${updateFields} WHERE id = ?`,
        updateValues
      );
      
      // Create progress update record
      await dbRun(
        `INSERT INTO progress_updates (id, objective_id, user_id, previous_value, new_value, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          webhookIntegration.objective_id,
          null, // System update
          valueBefore,
          valueAfter,
          'Updated via webhook'
        ]
      );
      
      // Create a comment in the activity feed
      // Build a detailed message showing all changed values
      const changedFields = [];
      
      if (updates.current_value !== undefined) {
        changedFields.push(`Current Value: ${previousValues.current_value} → ${updates.current_value}`);
      }
      if (updates.target_value !== undefined) {
        changedFields.push(`Target Value: ${previousValues.target_value} → ${updates.target_value}`);
      }
      if (updates.progress_percentage !== undefined) {
        changedFields.push(`Progress: ${Math.round(previousValues.progress_percentage)}% → ${Math.round(updates.progress_percentage)}%`);
      }
      
      // Use comment from payload if provided, otherwise use default message
      let commentContent;
      if (webhookComment) {
        // Use the comment from the webhook payload, but append the changes
        if (changedFields.length > 0) {
          commentContent = `${webhookComment}\n\nChanges:\n${changedFields.join('\n')}`;
        } else {
          commentContent = webhookComment;
        }
      } else {
        // Default comment format with all changes
        if (changedFields.length > 0) {
          commentContent = `Progress updated via webhook:\n${changedFields.join('\n')}`;
        } else {
          commentContent = `Progress updated via webhook: ${valueBefore} → ${valueAfter}${updates.progress_percentage !== undefined ? ` (${Math.round(updates.progress_percentage)}% complete)` : ''}`;
        }
      }
      
      await dbRun(
        `INSERT INTO comments (id, objective_id, user_id, content) VALUES (?, ?, ?, ?)`,
        [
          uuidv4(),
          webhookIntegration.objective_id,
          null, // System update (no user) - user_id is nullable
          commentContent
        ]
      );
      
      // Recalculate parent objective progress if applicable
      if (objective.parent_objective_id) {
        await calculateObjectiveProgress(objective.parent_objective_id);
      }
    }
    
    // Mark event as processed
    await dbRun(
      `UPDATE webhook_events 
       SET processed = 1, value_before = ?, value_after = ? 
       WHERE id = ?`,
      [valueBefore, valueAfter, eventId]
    );
    
    // Update webhook integration last_received_at
    await dbRun(
      'UPDATE webhook_integrations SET last_received_at = CURRENT_TIMESTAMP, failure_count = 0 WHERE id = ?',
      [webhookId]
    );
    
    res.json({ 
      success: true, 
      message: 'Webhook processed successfully',
      objective_id: objective.id,
      updates: updates
    });
  } catch (error) {
    console.error('Webhook processing error:', error);
    
    // Log error
    const webhookId = req.params.webhook_id;
    try {
      await dbRun(
        `INSERT INTO webhook_events (id, webhook_integration_id, payload, headers, processed, error_message)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          webhookId,
          JSON.stringify(req.body),
          JSON.stringify(req.headers),
          0,
          error.message
        ]
      );
      
      await dbRun(
        'UPDATE webhook_integrations SET failure_count = failure_count + 1 WHERE id = ?',
        [webhookId]
      );
    } catch (logError) {
      console.error('Error logging webhook error:', logError);
    }
    
    res.status(500).json({ error: 'Internal server error processing webhook' });
  }
});

// Webhook Management Endpoints

// Create webhook integration
app.post('/api/webhooks', async (req, res) => {
  try {
    const { integration_id, objective_id, field_mapping, webhook_secret } = req.body;
    
    if (!objective_id) {
      return res.status(400).json({ error: 'objective_id is required' });
    }
    
    const id = uuidv4();
    const secret = webhook_secret || crypto.randomBytes(32).toString('hex');
    
    const fieldMappingJson = typeof field_mapping === 'object' 
      ? JSON.stringify(field_mapping) 
      : field_mapping || '{}';
    
    await dbRun(
      `INSERT INTO webhook_integrations 
       (id, integration_id, objective_id, webhook_secret, field_mapping, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, integration_id || null, objective_id, secret, fieldMappingJson, 'active']
    );
    
    const webhook = await dbGet('SELECT * FROM webhook_integrations WHERE id = ?', [id]);
    // Use BASE_URL env var if set (for production), otherwise construct from request
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      ...webhook,
      webhook_url: `${baseUrl}/api/webhooks/${id}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all webhooks for an integration
app.get('/api/integrations/:integration_id/webhooks', async (req, res) => {
  try {
    // Also match webhooks with null integration_id (for localStorage integrations)
    const webhooks = await dbAll(
      `SELECT w.*, o.title as objective_title 
       FROM webhook_integrations w
       JOIN objectives o ON w.objective_id = o.id
       WHERE w.integration_id = ? OR w.integration_id IS NULL`,
      [req.params.integration_id]
    );
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const webhooksWithUrl = webhooks.map(w => ({
      ...w,
      webhook_url: `${baseUrl}/api/webhooks/${w.id}`,
      field_mapping: w.field_mapping ? JSON.parse(w.field_mapping) : {}
    }));
    
    res.json(webhooksWithUrl);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all webhooks (for debugging/listing all)
app.get('/api/webhooks', async (req, res) => {
  try {
    const webhooks = await dbAll(
      `SELECT w.*, o.title as objective_title 
       FROM webhook_integrations w
       JOIN objectives o ON w.objective_id = o.id
       ORDER BY w.created_at DESC`
    );
    
    // Use BASE_URL env var if set (for production), otherwise construct from request
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const webhooksWithUrl = webhooks.map(w => ({
      ...w,
      webhook_url: `${baseUrl}/api/webhooks/${w.id}`,
      field_mapping: w.field_mapping ? JSON.parse(w.field_mapping) : {}
    }));
    
    res.json(webhooksWithUrl);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get webhook details
app.get('/api/webhooks/:id', async (req, res) => {
  try {
    const webhook = await dbGet(
      `SELECT w.*, o.title as objective_title 
       FROM webhook_integrations w
       JOIN objectives o ON w.objective_id = o.id
       WHERE w.id = ?`,
      [req.params.id]
    );
    
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    
    // Use BASE_URL env var if set (for production), otherwise construct from request
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({
      ...webhook,
      webhook_url: `${baseUrl}/api/webhooks/${webhook.id}`,
      field_mapping: webhook.field_mapping ? JSON.parse(webhook.field_mapping) : {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update webhook
app.put('/api/webhooks/:id', async (req, res) => {
  try {
    const { field_mapping, status, webhook_secret } = req.body;
    const updates = [];
    const params = [];
    
    if (field_mapping !== undefined) {
      const fieldMappingJson = typeof field_mapping === 'object' 
        ? JSON.stringify(field_mapping) 
        : field_mapping;
      updates.push('field_mapping = ?');
      params.push(fieldMappingJson);
    }
    
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }
    
    if (webhook_secret !== undefined) {
      updates.push('webhook_secret = ?');
      params.push(webhook_secret);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);
    
    await dbRun(
      `UPDATE webhook_integrations SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    
    const webhook = await dbGet('SELECT * FROM webhook_integrations WHERE id = ?', [req.params.id]);
    // Use BASE_URL env var if set (for production), otherwise construct from request
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({
      ...webhook,
      webhook_url: `${baseUrl}/api/webhooks/${webhook.id}`,
      field_mapping: webhook.field_mapping ? JSON.parse(webhook.field_mapping) : {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete webhook
app.delete('/api/webhooks/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM webhook_integrations WHERE id = ?', [req.params.id]);
    res.json({ message: 'Webhook deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get webhook events
app.get('/api/webhooks/:id/events', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const events = await dbAll(
      `SELECT * FROM webhook_events 
       WHERE webhook_integration_id = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [req.params.id, limit, offset]
    );
    
    const eventsWithParsed = events.map(event => ({
      ...event,
      payload: event.payload ? JSON.parse(event.payload) : null,
      headers: event.headers ? JSON.parse(event.headers) : null
    }));
    
    res.json(eventsWithParsed);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

