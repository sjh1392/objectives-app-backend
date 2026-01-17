import { v4 as uuidv4 } from 'uuid';
import supabase from './db.js';
import { hashPassword } from './utils/password.js';

async function seedDatabase() {
  console.log('Starting database seed...');

  // Clear existing data (in correct order to respect foreign keys)
  await supabase.from('progress_updates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('comments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('key_results').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('objective_contributors').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('webhook_events').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('webhook_integrations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('objectives').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('departments').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Create departments
  const departments = [
    { id: uuidv4(), name: 'Engineering', description: 'Software development and technical operations' },
    { id: uuidv4(), name: 'Product', description: 'Product management and strategy' },
    { id: uuidv4(), name: 'Marketing', description: 'Marketing and brand management' },
    { id: uuidv4(), name: 'Sales', description: 'Sales and business development' },
    { id: uuidv4(), name: 'Customer Success', description: 'Customer support and success' }
  ];

  const { error: deptError } = await supabase.from('departments').insert(departments);
  if (deptError) {
    console.error('Error creating departments:', deptError);
    throw deptError;
  }

  console.log(`Created ${departments.length} departments`);

  // Create or get default organization for test user
  let testOrgId = uuidv4();
  const testOrgSlug = 'test-organization';
  
  // Check if test org already exists
  const { data: existingOrg } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', testOrgSlug)
    .single();
  
  if (existingOrg) {
    testOrgId = existingOrg.id;
    console.log('Using existing test organization');
  } else {
    const { error: orgError } = await supabase.from('organizations').insert({
      id: testOrgId,
      name: 'Test Organization',
      slug: testOrgSlug
    });
    if (orgError) {
      console.error('Error creating test organization:', orgError);
      throw orgError;
    }
    console.log('Created test organization');
  }

  // Create test user with password (email verified, ready to login)
  const testPassword = 'test123456'; // Easy to remember password
  const testPasswordHash = await hashPassword(testPassword);
  const testUserId = uuidv4();
  
  const testUser = {
    id: testUserId,
    email: 'test@example.com',
    name: 'Test User',
    role: 'Admin',
    department: departments[0].id,
    password_hash: testPasswordHash,
    email_verified: true,
    organization_id: testOrgId
  };

  // Check if test user already exists
  const { data: existingTestUser } = await supabase
    .from('users')
    .select('id')
    .eq('email', 'test@example.com')
    .single();
  
  if (existingTestUser) {
    // Update existing test user
    const { error: updateError } = await supabase
      .from('users')
      .update({
        password_hash: testPasswordHash,
        email_verified: true,
        organization_id: testOrgId,
        role: 'Admin'
      })
      .eq('id', existingTestUser.id);
    
    if (updateError) {
      console.error('Error updating test user:', updateError);
      throw updateError;
    }
    console.log('✅ Updated test user (ready to login)');
    console.log('   Email: test@example.com');
    console.log('   Password: test123456');
  } else {
    // Create new test user
    const { error: testUserError } = await supabase.from('users').insert(testUser);
    if (testUserError) {
      console.error('Error creating test user:', testUserError);
      throw testUserError;
    }
    console.log('✅ Created test user (ready to login)');
    console.log('   Email: test@example.com');
    console.log('   Password: test123456');
  }

  // Create other users (without passwords - they'll need to register or be invited)
  const users = [
    { id: uuidv4(), email: 'alice.johnson@company.com', name: 'Alice Johnson', role: 'Manager', department: departments[0].id, organization_id: testOrgId },
    { id: uuidv4(), email: 'bob.smith@company.com', name: 'Bob Smith', role: 'Team Member', department: departments[0].id, organization_id: testOrgId },
    { id: uuidv4(), email: 'carol.white@company.com', name: 'Carol White', role: 'Manager', department: departments[1].id, organization_id: testOrgId },
    { id: uuidv4(), email: 'david.brown@company.com', name: 'David Brown', role: 'Team Member', department: departments[1].id, organization_id: testOrgId },
    { id: uuidv4(), email: 'emma.davis@company.com', name: 'Emma Davis', role: 'Manager', department: departments[2].id, organization_id: testOrgId },
    { id: uuidv4(), email: 'frank.miller@company.com', name: 'Frank Miller', role: 'Team Member', department: departments[2].id, organization_id: testOrgId },
    { id: uuidv4(), email: 'grace.wilson@company.com', name: 'Grace Wilson', role: 'Admin', department: null, organization_id: testOrgId }
  ];

  const { error: usersError } = await supabase.from('users').insert(users);
  if (usersError) {
    console.error('Error creating users:', usersError);
    throw usersError;
  }

  console.log(`Created ${users.length} additional users`);

  // Calculate future dates (relative to current date)
  const today = new Date();
  const nextMonth = new Date(today);
  nextMonth.setMonth(today.getMonth() + 1);
  const nextQuarter = new Date(today);
  nextQuarter.setMonth(today.getMonth() + 3);
  const nextSixMonths = new Date(today);
  nextSixMonths.setMonth(today.getMonth() + 6);
  const nextYear = new Date(today);
  nextYear.setFullYear(today.getFullYear() + 1);

  const formatDate = (date) => date.toISOString().split('T')[0];

  // Create objectives with various tags
  const objectives = [
    {
      id: uuidv4(),
      title: 'Increase Monthly Active Users by 30%',
      description: 'Grow our user base by implementing new features and improving user engagement',
      owner_id: users[0].id,
      department_id: departments[0].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 30,
      current_value: 18,
      tags: ['growth', 'users', 'q2-2024', 'engineering']
    },
    {
      id: uuidv4(),
      title: 'Launch Mobile App Version 2.0',
      description: 'Release major update with new features and improved performance',
      owner_id: users[1].id,
      department_id: departments[0].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextQuarter),
      target_value: 100,
      current_value: 65,
      tags: ['product', 'mobile', 'launch', 'engineering', 'q2-2024']
    },
    {
      id: uuidv4(),
      title: 'Improve Customer Satisfaction Score to 4.5+',
      description: 'Enhance customer experience through better support and product improvements',
      owner_id: users[4].id,
      department_id: departments[4].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 4.5,
      current_value: 4.2,
      tags: ['customer-success', 'satisfaction', 'q2-2024', 'quality']
    },
    {
      id: uuidv4(),
      title: 'Generate $2M in Q2 Revenue',
      description: 'Achieve quarterly revenue target through new deals and customer expansion',
      owner_id: users[5].id,
      department_id: departments[3].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextQuarter),
      target_value: 2000000,
      current_value: 1450000,
      tags: ['revenue', 'sales', 'q2-2024', 'financial']
    },
    {
      id: uuidv4(),
      title: 'Increase Brand Awareness by 40%',
      description: 'Execute marketing campaigns across multiple channels',
      owner_id: users[4].id,
      department_id: departments[2].id,
      status: 'Active',
      priority: 'Medium',
      start_date: formatDate(today),
      due_date: formatDate(nextYear),
      target_value: 40,
      current_value: 22,
      tags: ['marketing', 'brand', 'awareness', '2024']
    },
    {
      id: uuidv4(),
      title: 'Reduce System Downtime to <0.1%',
      description: 'Improve infrastructure reliability and monitoring',
      owner_id: users[0].id,
      department_id: departments[0].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 0.1,
      current_value: 0.3,
      tags: ['reliability', 'infrastructure', 'engineering', 'quality']
    },
    {
      id: uuidv4(),
      title: 'Implement AI-Powered Recommendations',
      description: 'Develop machine learning features to improve user experience',
      owner_id: users[1].id,
      department_id: departments[0].id,
      status: 'On Hold',
      priority: 'Medium',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 100,
      current_value: 25,
      tags: ['ai', 'ml', 'product', 'engineering', 'innovation']
    },
    {
      id: uuidv4(),
      title: 'Expand to 3 New Markets',
      description: 'Launch product in Europe, Asia-Pacific, and Latin America',
      owner_id: users[2].id,
      department_id: departments[1].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextYear),
      target_value: 3,
      current_value: 1,
      tags: ['expansion', 'international', 'product', 'growth']
    },
    {
      id: uuidv4(),
      title: 'Achieve 95% Code Coverage',
      description: 'Improve test coverage across all codebases',
      owner_id: users[0].id,
      department_id: departments[0].id,
      status: 'Active',
      priority: 'Medium',
      start_date: formatDate(today),
      due_date: formatDate(nextQuarter),
      target_value: 95,
      current_value: 78,
      tags: ['testing', 'quality', 'engineering', 'q2-2024']
    },
    {
      id: uuidv4(),
      title: 'Launch Partner Program',
      description: 'Establish partner ecosystem and onboarding process',
      owner_id: users[3].id,
      department_id: departments[1].id,
      status: 'Draft',
      priority: 'Medium',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 100,
      current_value: 0,
      tags: ['partners', 'business-development', 'product', 'q3-2024']
    },
    {
      id: uuidv4(),
      title: 'Reduce Customer Churn to <5%',
      description: 'Improve retention through better onboarding and support',
      owner_id: users[4].id,
      department_id: departments[4].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 5,
      current_value: 7.5,
      tags: ['retention', 'churn', 'customer-success', 'quality']
    },
    {
      id: uuidv4(),
      title: 'Launch Content Marketing Initiative',
      description: 'Publish 50 high-quality blog posts and case studies',
      owner_id: users[4].id,
      department_id: departments[2].id,
      status: 'Active',
      priority: 'Medium',
      start_date: formatDate(today),
      due_date: formatDate(nextYear),
      target_value: 50,
      current_value: 28,
      tags: ['content', 'marketing', 'seo', '2024']
    },
    {
      id: uuidv4(),
      title: 'Complete SOC 2 Certification',
      description: 'Obtain security certification for enterprise sales',
      owner_id: users[0].id,
      department_id: departments[0].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 100,
      current_value: 70,
      tags: ['security', 'compliance', 'enterprise', 'engineering']
    },
    {
      id: uuidv4(),
      title: 'Improve Page Load Speed by 50%',
      description: 'Optimize frontend performance and reduce server response times',
      owner_id: users[1].id,
      department_id: departments[0].id,
      status: 'Completed',
      priority: 'Medium',
      start_date: '2023-10-01',
      due_date: '2024-03-31',
      target_value: 50,
      current_value: 52,
      tags: ['performance', 'frontend', 'engineering', 'completed', 'q1-2024']
    },
    {
      id: uuidv4(),
      title: 'Establish Data Analytics Dashboard',
      description: 'Build comprehensive analytics platform for business insights',
      owner_id: users[2].id,
      department_id: departments[1].id,
      status: 'Active',
      priority: 'Medium',
      start_date: formatDate(today),
      due_date: formatDate(nextSixMonths),
      target_value: 100,
      current_value: 45,
      tags: ['analytics', 'data', 'product', 'engineering']
    },
    {
      id: uuidv4(),
      title: 'Q1 2025 Product Roadmap Execution',
      description: 'Deliver key features planned for Q1 including advanced reporting and API v2',
      owner_id: users[2].id,
      department_id: departments[1].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(nextMonth),
      due_date: formatDate(nextQuarter),
      target_value: 100,
      current_value: 0,
      tags: ['product', 'roadmap', 'q1-2025', 'features']
    },
    {
      id: uuidv4(),
      title: 'International Expansion Phase 2',
      description: 'Launch in 5 additional countries in Asia-Pacific region',
      owner_id: users[2].id,
      department_id: departments[1].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(nextQuarter),
      due_date: formatDate(nextYear),
      target_value: 5,
      current_value: 0,
      tags: ['expansion', 'international', 'apac', 'growth']
    },
    {
      id: uuidv4(),
      title: 'Enterprise Feature Suite Launch',
      description: 'Roll out enterprise-grade features including SSO, advanced permissions, and audit logs',
      owner_id: users[0].id,
      department_id: departments[0].id,
      status: 'Active',
      priority: 'High',
      start_date: formatDate(nextMonth),
      due_date: formatDate(nextSixMonths),
      target_value: 100,
      current_value: 15,
      tags: ['enterprise', 'features', 'security', 'engineering']
    },
    {
      id: uuidv4(),
      title: 'Annual Customer Conference 2025',
      description: 'Organize and execute annual customer conference with 500+ attendees',
      owner_id: users[4].id,
      department_id: departments[2].id,
      status: 'Active',
      priority: 'Medium',
      start_date: formatDate(today),
      due_date: formatDate(nextYear),
      target_value: 500,
      current_value: 120,
      tags: ['events', 'marketing', 'customer-engagement', '2025']
    }
  ];

  // Prepare objectives with calculated progress_percentage, tags as arrays, and organization_id
  const objectivesToInsert = objectives.map(obj => {
    const progressPercentage = obj.target_value > 0 
      ? (obj.current_value / obj.target_value) * 100 
      : 0;
    return {
      ...obj,
      progress_percentage: progressPercentage,
      tags: obj.tags, // Already an array - Supabase JSONB will handle it
      organization_id: testOrgId // Assign all objectives to test organization
    };
  });

  const { error: objError } = await supabase.from('objectives').insert(objectivesToInsert);
  if (objError) {
    console.error('Error creating objectives:', objError);
    throw objError;
  }

  // Create key results for each objective
  const keyResults = [];
  for (const obj of objectives) {
    const progressPercentage = obj.target_value > 0 
      ? (obj.current_value / obj.target_value) * 100 
      : 0;

    const keyResultsData = [
      {
        id: uuidv4(),
        objective_id: obj.id,
        title: 'Implement feature X',
        target_value: 100,
        current_value: Math.floor(progressPercentage),
        progress_percentage: Math.floor(progressPercentage),
        unit: 'percentage',
        status: 'In Progress',
        auto_update_progress: true
      },
      {
        id: uuidv4(),
        objective_id: obj.id,
        title: 'Complete milestone Y',
        target_value: 100,
        current_value: Math.floor(progressPercentage * 0.8),
        progress_percentage: Math.floor(progressPercentage * 0.8),
        unit: 'percentage',
        status: 'In Progress',
        auto_update_progress: true
      }
    ];

    keyResults.push(...keyResultsData);
  }

  const { error: krError } = await supabase.from('key_results').insert(keyResults);
  if (krError) {
    console.error('Error creating key results:', krError);
    throw krError;
  }

  console.log(`Created ${objectives.length} objectives with key results`);

  // Create some comments
  const comments = [
    { id: uuidv4(), objective_id: objectives[0].id, user_id: users[0].id, content: 'Great progress so far! Let\'s keep the momentum going.' },
    { id: uuidv4(), objective_id: objectives[0].id, user_id: users[1].id, content: 'We\'re on track to meet the target.' },
    { id: uuidv4(), objective_id: objectives[3].id, user_id: users[5].id, content: 'Strong Q2 performance, exceeding expectations.' },
    { id: uuidv4(), objective_id: objectives[6].id, user_id: users[2].id, content: 'Putting this on hold due to resource constraints.' }
  ];

  const { error: commentsError } = await supabase.from('comments').insert(comments);
  if (commentsError) {
    console.error('Error creating comments:', commentsError);
    throw commentsError;
  }

  console.log(`Created ${comments.length} comments`);
  console.log('\n✅ Database seeded successfully!');
  console.log('\n📊 Summary:');
  console.log(`- ${departments.length} departments`);
  console.log(`- ${users.length + 1} users (including test user)`);
  console.log(`- ${objectives.length} objectives`);
  console.log(`- ${keyResults.length} key results`);
  console.log(`- ${comments.length} comments`);
  console.log('\n🔐 Test User Credentials:');
  console.log('   Email: test@example.com');
  console.log('   Password: test123456');
  console.log('   Status: Email verified, ready to login!');
  console.log('\n💡 You can use these credentials to login without email verification.');
}

seedDatabase().catch(console.error);
