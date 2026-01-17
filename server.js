import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import supabase from './db.js';
import { dbRun, dbGet, dbAll } from './db-helpers.js';

const app = express();
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
    
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
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

// Get all objectives with optional filters
app.get('/api/objectives', async (req, res) => {
  try {
    let queryBuilder = supabase.from('objectives').select('*');

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
app.post('/api/objectives', async (req, res) => {
  try {
    const {
      title,
      description,
      owner_id,
      department_id,
      parent_objective_id,
      status = 'Active',
      priority = 'Medium',
      start_date,
      due_date,
      target_value,
      current_value,
      tags = []
    } = req.body;

    const id = uuidv4();
    // Tags stored as JSONB array in Supabase
    const tagsArray = Array.isArray(tags) ? tags : [];

    const { data: objective, error } = await supabase
      .from('objectives')
      .insert({
        id,
        title,
        description,
        owner_id,
        department_id,
        parent_objective_id,
        status,
        priority,
        start_date,
        due_date,
        target_value,
        current_value,
        tags: tagsArray
      })
      .select()
      .single();

    if (error) throw error;

    // Ensure tags is an array
    objective.tags = Array.isArray(objective.tags) ? objective.tags : [];

    res.status(201).json(objective);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    if (department_id !== undefined) updates.department_id = department_id;
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
    const { current_value, notes } = req.body;
    const objectiveId = req.params.id;

    const objective = await dbGet('SELECT * FROM objectives WHERE id = ?', [objectiveId]);
    if (!objective) {
      return res.status(404).json({ error: 'Objective not found' });
    }

    const previousValue = objective.current_value || 0;
    const targetValue = objective.target_value || 100;
    const newProgress = targetValue > 0 ? (current_value / targetValue) * 100 : 0;
    const now = new Date().toISOString();

    await supabase
      .from('objectives')
      .update({ 
        current_value, 
        progress_percentage: newProgress, 
        updated_at: now 
      })
      .eq('id', objectiveId);

    // Log progress update
    await supabase
      .from('progress_updates')
      .insert({
        id: uuidv4(),
        objective_id: objectiveId,
        user_id: objective.owner_id,
        previous_value: previousValue,
        new_value: current_value,
        notes: notes || ''
      });

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
app.get('/api/users', async (req, res) => {
  try {
    const users = await dbAll('SELECT * FROM users ORDER BY name');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { email, name, role = 'Team Member', department } = req.body;
    const id = uuidv4();

    await dbRun(
      'INSERT INTO users (id, email, name, role, department) VALUES (?, ?, ?, ?, ?)',
      [id, email, name, role, department || null]
    );

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
    res.status(201).json(user);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { email, name, role, department } = req.body;
    const updates = [];
    const params = [];

    if (email !== undefined) { updates.push('email = ?'); params.push(email); }
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (role !== undefined) { updates.push('role = ?'); params.push(role); }
    if (department !== undefined) { updates.push('department = ?'); params.push(department || null); }

    params.push(req.params.id);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    await dbRun(query, params);

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json(user);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.delete('/api/users/:id', async (req, res) => {
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

// Company endpoints
app.get('/api/company', async (req, res) => {
  try {
    const companies = await dbAll('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    if (companies.length === 0) {
      return res.json(null);
    }
    res.json(companies[0]);
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

// Logo upload endpoint
app.post('/api/company/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Get existing company to update, or create new one
    const existing = await dbAll('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    
    // Delete old logo if exists
    if (existing.length > 0 && existing[0].logo_url) {
      const oldLogoPath = path.join(__dirname, 'public', existing[0].logo_url);
      if (fs.existsSync(oldLogoPath)) {
        fs.unlinkSync(oldLogoPath);
      }
    }
    
    // Create logo URL path
    const logoUrl = `/uploads/logos/${req.file.filename}`;
    
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
    if (req.file) {
      const filePath = path.join(__dirname, 'public', 'uploads', 'logos', req.file.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
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
    const id = uuidv4();
    
    const { data: comment, error: insertError } = await supabase
      .from('comments')
      .insert({
        id,
        objective_id: req.params.id,
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
    res.status(201).json({
      ...webhook,
      webhook_url: `${req.protocol}://${req.get('host')}/api/webhooks/${id}`
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
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
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
    const baseUrl = `${req.protocol}://${req.get('host')}`;
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

