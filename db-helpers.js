import supabase from './db.js';

// Helper function to run database queries (INSERT, UPDATE, DELETE)
// Returns { id, changes } for compatibility with existing code
// Note: Complex queries may need to be rewritten to use Supabase client directly
export async function dbRun(query, params = []) {
  const queryUpper = query.trim().toUpperCase();
  
  if (queryUpper.startsWith('INSERT INTO')) {
    // Extract table name
    const tableMatch = query.match(/INSERT INTO\s+(\w+)/i);
    if (!tableMatch) throw new Error('Could not parse table name from INSERT query');
    
    const tableName = tableMatch[1];
    
    // Extract column names and values
    const valuesMatch = query.match(/\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!valuesMatch) throw new Error('Could not parse INSERT values');
    
    const columns = valuesMatch[1].split(',').map(c => c.trim());
    const placeholders = valuesMatch[2].split(',').map(p => p.trim());
    
    // Build data object
    const data = {};
    let paramIndex = 0;
    columns.forEach((col, idx) => {
      const placeholder = placeholders[idx];
      if (placeholder === '?') {
        data[col] = params[paramIndex++];
      } else if (placeholder === 'CURRENT_TIMESTAMP') {
        data[col] = new Date().toISOString();
      } else {
        // Handle literal values
        let value = placeholder;
        if ((value.startsWith("'") && value.endsWith("'")) || 
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        data[col] = value;
      }
    });
    
    const { data: result, error } = await supabase
      .from(tableName)
      .insert(data)
      .select()
      .single();
    
    if (error) throw error;
    
    return { id: result.id, changes: 1 };
  } else if (queryUpper.startsWith('UPDATE')) {
    // Extract table name and WHERE clause
    const updateMatch = query.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+?)(?:\s*$)/i);
    if (!updateMatch) throw new Error('Could not parse UPDATE query');
    
    const tableName = updateMatch[1];
    const setClause = updateMatch[2];
    const whereClause = updateMatch[3];
    
    // Parse SET clause - handle multiple assignments
    const updates = {};
    const setParts = setClause.split(',').map(s => s.trim());
    let paramIndex = 0;
    
    setParts.forEach(part => {
      const [key, valueExpr] = part.split('=').map(s => s.trim());
      if (valueExpr === '?') {
        updates[key] = params[paramIndex++];
      } else if (valueExpr === 'CURRENT_TIMESTAMP') {
        updates[key] = new Date().toISOString();
      } else {
        // For UPDATE queries built dynamically, the value is likely in params
        // We'll use the paramIndex if available, otherwise parse the expression
        const valueMatch = valueExpr.match(/^\?$/);
        if (valueMatch && paramIndex < params.length) {
          updates[key] = params[paramIndex++];
        } else {
          // Try to extract from remaining params
          if (paramIndex < params.length) {
            updates[key] = params[paramIndex++];
          }
        }
      }
    });
    
    // Parse WHERE clause - simple id = ? case
    const whereMatch = whereClause.match(/(\w+)\s*=\s*\?/);
    if (!whereMatch) throw new Error('Complex WHERE clauses should use Supabase client directly');
    
    const whereKey = whereMatch[1];
    const whereValue = params[params.length - 1]; // Last param is usually WHERE value
    
    const { data, error } = await supabase
      .from(tableName)
      .update(updates)
      .eq(whereKey, whereValue)
      .select();
    
    if (error) throw error;
    
    return { id: null, changes: data?.length || 0 };
  } else if (queryUpper.startsWith('DELETE')) {
    const deleteMatch = query.match(/DELETE FROM\s+(\w+)\s+WHERE\s+(.+)/i);
    if (!deleteMatch) throw new Error('Could not parse DELETE query');
    
    const tableName = deleteMatch[1];
    const whereClause = deleteMatch[2];
    
    const whereMatch = whereClause.match(/(\w+)\s*=\s*\?/);
    if (!whereMatch) throw new Error('Complex WHERE clauses should use Supabase client directly');
    
    const whereKey = whereMatch[1];
    const whereValue = params[0];
    
    const { data, error } = await supabase
      .from(tableName)
      .delete()
      .eq(whereKey, whereValue)
      .select();
    
    if (error) throw error;
    
    return { id: null, changes: data?.length || 0 };
  }
  
  throw new Error(`Unsupported query type or complex query - use Supabase client directly: ${query.substring(0, 50)}`);
}

// Helper function to get a single row
export async function dbGet(query, params = []) {
  const queryUpper = query.trim().toUpperCase();
  
  if (!queryUpper.startsWith('SELECT')) {
    throw new Error(`Unsupported query type: ${query.substring(0, 50)}`);
  }
  
  // Handle JOIN queries differently
  if (queryUpper.includes('JOIN')) {
    // For JOINs, we'll need to use Supabase's select with dot notation or raw SQL
    // This will be handled in server.js directly
    throw new Error('JOIN queries should use Supabase client directly');
  }
  
  const fromMatch = query.match(/FROM\s+(\w+)/i);
  if (!fromMatch) throw new Error('Could not parse table name from query');
  
  const tableName = fromMatch[1];
  let queryBuilder = supabase.from(tableName).select('*');
  
  // Handle WHERE clause
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
  if (whereMatch) {
    const whereClause = whereMatch[1].trim();
    const eqMatch = whereClause.match(/(\w+)\s*=\s*\?/);
    if (eqMatch) {
      queryBuilder = queryBuilder.eq(eqMatch[1], params[0]);
    }
  }
  
  const { data, error } = await queryBuilder.single();
  
  if (error) {
    if (error.code === 'PGRST116') {
      return null; // No rows - return null like SQLite
    }
    throw error;
  }
  
  return data;
}

// Helper function to get multiple rows
// Note: Complex queries with JOINs, subqueries, etc. should use Supabase client directly
export async function dbAll(query, params = []) {
  const queryUpper = query.trim().toUpperCase();
  
  if (!queryUpper.startsWith('SELECT')) {
    throw new Error(`Unsupported query type: ${query.substring(0, 50)}`);
  }
  
  // Handle complex queries with JOINs
  if (queryUpper.includes('JOIN')) {
    throw new Error('JOIN queries should use Supabase client directly');
  }
  
  const fromMatch = query.match(/FROM\s+(\w+)/i);
  if (!fromMatch) throw new Error('Could not parse table name from query');
  
  const tableName = fromMatch[1];
  let queryBuilder = supabase.from(tableName).select('*');
  
  // Handle WHERE clause
  const whereMatch = query.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
  if (whereMatch) {
    const whereClause = whereMatch[1].trim();
    
    // Handle WHERE 1=1 (no filter)
    if (whereClause === '1=1') {
      // No filter
    } else {
      // Simple WHERE key = ? case
      const eqMatch = whereClause.match(/(\w+)\s*=\s*\?/);
      if (eqMatch) {
        const paramIndex = (query.substring(0, query.indexOf('WHERE')).match(/\?/g) || []).length;
        queryBuilder = queryBuilder.eq(eqMatch[1], params[paramIndex] || params[0]);
      }
      
      // Handle WHERE key != ?
      const neMatch = whereClause.match(/(\w+)\s*!=\s*\?/);
      if (neMatch) {
        const paramIndex = (query.substring(0, query.indexOf('WHERE')).match(/\?/g) || []).length;
        queryBuilder = queryBuilder.neq(neMatch[1], params[paramIndex] || params[0]);
      }
      
      // Handle WHERE key IS NOT NULL
      if (whereClause.includes('IS NOT NULL')) {
        const keyMatch = whereClause.match(/(\w+)\s+IS NOT NULL/);
        if (keyMatch) {
          queryBuilder = queryBuilder.not(keyMatch[1], 'is', null);
        }
      }
      
      // Handle LIKE queries (will be converted to ilike)
      const likeMatch = whereClause.match(/(\w+)\s+LIKE\s+\?/);
      if (likeMatch) {
        const paramIndex = (query.substring(0, query.indexOf('WHERE')).match(/\?/g) || []).length;
        const pattern = params[paramIndex] || params[0];
        // Convert SQL LIKE pattern to Supabase ilike
        const supabasePattern = pattern.replace(/%/g, '');
        queryBuilder = queryBuilder.ilike(likeMatch[1], supabasePattern);
      }
    }
  }
  
  // Handle ORDER BY
  const orderMatch = query.match(/ORDER BY\s+([^\s]+(?:\s+ASC|\s+DESC)?)/i);
  if (orderMatch) {
    const orderClause = orderMatch[1].trim();
    const parts = orderClause.split(/\s+/);
    const column = parts[0];
    const direction = parts[1]?.toUpperCase() || 'ASC';
    queryBuilder = queryBuilder.order(column, { ascending: direction === 'ASC' });
  }
  
  // Handle LIMIT
  const limitMatch = query.match(/LIMIT\s+(\d+)/i);
  if (limitMatch) {
    queryBuilder = queryBuilder.limit(parseInt(limitMatch[1]));
  }
  
  const { data, error } = await queryBuilder;
  
  if (error) throw error;
  
  return data || [];
}

