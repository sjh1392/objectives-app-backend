import { verifyToken } from '../utils/jwt.js';
import { dbGet } from '../db-helpers.js';
import supabase from '../db.js';

/**
 * Authentication middleware - verifies JWT token
 * Adds user and organization info to request object
 */
export async function authenticate(req, res, next) {
  try {
    // Get token from Authorization header or cookie
    const authHeader = req.headers.authorization;
    let token = null;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    // Verify token
    const decoded = verifyToken(token);
    
    // Get user from database to ensure they still exist and are active
    const user = await dbGet(
      'SELECT id, email, name, role, organization_id, email_verified FROM users WHERE id = ?',
      [decoded.userId]
    );
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Email not verified' });
    }
    
    // Add user info to request
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organization_id
    };
    
    next();
  } catch (error) {
    if (error.message === 'Token has expired' || error.message === 'Invalid token') {
      return res.status(401).json({ error: error.message });
    }
    console.error('Authentication error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional authentication - doesn't fail if no token, but adds user if token is valid
 */
export async function optionalAuthenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    let token = null;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }
    
    if (token) {
      const decoded = verifyToken(token);
      const user = await dbGet(
        'SELECT id, email, name, role, organization_id, email_verified FROM users WHERE id = ?',
        [decoded.userId]
      );
      
      if (user && user.email_verified) {
        req.user = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          organizationId: user.organization_id
        };
      }
    }
    
    next();
  } catch (error) {
    // Ignore auth errors for optional auth
    next();
  }
}

/**
 * Role-based authorization middleware
 * @param {...string} allowedRoles - Roles that are allowed to access the route
 */
export function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions',
        required: allowedRoles,
        current: req.user.role
      });
    }
    
    next();
  };
}

/**
 * Organization scoping middleware - ensures user can only access their organization's data
 * Adds organization filter to request
 */
export function requireOrganization(req, res, next) {
  if (!req.user || !req.user.organizationId) {
    return res.status(403).json({ error: 'Organization access required' });
  }
  
  req.organizationId = req.user.organizationId;
  next();
}

/**
 * Check if user is admin or manager
 */
export function requireAdminOrManager(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!['Admin', 'Manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin or Manager role required' });
  }
  
  next();
}

