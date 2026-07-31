const { createClient } = require('@supabase/supabase-js');

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
      requestProcessed: false
    });
  }

  const token = authHeader.split(' ')[1];

  // Verify token with Supabase
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    console.error('[authMiddleware] getUser failed:', error?.message, '| status:', error?.status, '| has_user:', !!user);
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
      code: 'AUTH_INVALID',
      requestProcessed: false
    });
  }

  // Attach user and user-scoped client (respects RLS)
  req.user = user;
  req.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });

  next();
}

module.exports = authMiddleware;
