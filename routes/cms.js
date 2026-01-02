// routes/cms.js
const express = require('express');
const router = express.Router();
const { db, admin } = require('../server');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');

// GET /api/v1/cms/pages - List published pages (or all for admins)
router.get('/pages', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = db.collection('cms_pages');

    // Non-authenticated users or customers can only see published pages
    if (!req.user || req.user.role === 'customer') {
      query = query.where('status', '==', 'published');
    } else if (status) {
      // Admins can filter by status
      query = query.where('status', '==', status);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();

    const pages = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      pages.push({
        id: doc.id,
        title: data.title,
        slug: data.slug,
        status: data.status,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        // Only include full content for admins
        ...(req.user && (req.user.role === 'admin' || req.user.role === 'super_admin') 
          ? { content: data.content } 
          : {})
      });
    });

    res.json({
      success: true,
      message: 'Pages retrieved successfully',
      data: pages,
      error: null
    });
  } catch (error) {
    console.error('Get CMS pages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve pages',
      data: null,
      error: { code: 'FETCH_FAILED' }
    });
  }
});

// GET /api/v1/cms/pages/slug/:slug - Get page by slug
router.get('/pages/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const snapshot = await db.collection('cms_pages')
      .where('slug', '==', slug)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        message: 'Page not found',
        data: null,
        error: { code: 'PAGE_NOT_FOUND' }
      });
    }

    const doc = snapshot.docs[0];
    const pageData = doc.data();

    // Check if page is published (unless user is admin)
    if (pageData.status !== 'published' && 
        (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin'))) {
      return res.status(404).json({
        success: false,
        message: 'Page not found',
        data: null,
        error: { code: 'PAGE_NOT_FOUND' }
      });
    }

    res.json({
      success: true,
      message: 'Page retrieved successfully',
      data: {
        id: doc.id,
        ...pageData
      },
      error: null
    });
  } catch (error) {
    console.error('Get CMS page error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve page',
      data: null,
      error: { code: 'FETCH_FAILED' }
    });
  }
});

// GET /api/v1/cms/pages/:pageId - Get page by ID
router.get('/pages/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;

    const pageDoc = await db.collection('cms_pages').doc(pageId).get();

    if (!pageDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Page not found',
        data: null,
        error: { code: 'PAGE_NOT_FOUND' }
      });
    }

    const pageData = pageDoc.data();

    // Check if page is published (unless user is admin)
    if (pageData.status !== 'published' && 
        (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin'))) {
      return res.status(404).json({
        success: false,
        message: 'Page not found',
        data: null,
        error: { code: 'PAGE_NOT_FOUND' }
      });
    }

    res.json({
      success: true,
      message: 'Page retrieved successfully',
      data: {
        id: pageDoc.id,
        ...pageData
      },
      error: null
    });
  } catch (error) {
    console.error('Get CMS page error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve page',
      data: null,
      error: { code: 'FETCH_FAILED' }
    });
  }
});

// POST /api/v1/cms/pages - Create new page (Admin only)
router.post('/pages', verifyToken, requireRole('admin', 'super_admin'), auditLog, async (req, res) => {
  try {
    const { title, slug, content, status = 'draft', metaDescription, metaKeywords } = req.body;

    // Validation
    if (!title || !slug || !content) {
      return res.status(400).json({
        success: false,
        message: 'Title, slug, and content are required',
        data: null,
        error: { code: 'VALIDATION_ERROR' }
      });
    }

    // Validate slug format (alphanumeric and hyphens only)
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({
        success: false,
        message: 'Slug must contain only lowercase letters, numbers, and hyphens',
        data: null,
        error: { code: 'INVALID_SLUG' }
      });
    }

    // Check if slug already exists
    const existingPage = await db.collection('cms_pages')
      .where('slug', '==', slug)
      .get();

    if (!existingPage.empty) {
      return res.status(409).json({
        success: false,
        message: 'Page with this slug already exists',
        data: null,
        error: { code: 'DUPLICATE_SLUG' }
      });
    }

    const pageData = {
      title,
      slug,
      content,
      status: ['draft', 'published'].includes(status) ? status : 'draft',
      metaDescription: metaDescription || '',
      metaKeywords: metaKeywords || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.id
    };

    const pageRef = await db.collection('cms_pages').add(pageData);

    res.status(201).json({
      success: true,
      message: 'Page created successfully',
      data: {
        id: pageRef.id,
        ...pageData
      },
      error: null
    });
  } catch (error) {
    console.error('Create CMS page error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create page',
      data: null,
      error: { code: 'CREATE_FAILED' }
    });
  }
});

// PATCH /api/v1/cms/pages/:pageId - Update page (Admin only)
router.patch('/pages/:pageId', verifyToken, requireRole('admin', 'super_admin'), auditLog, async (req, res) => {
  try {
    const { pageId } = req.params;
    const updates = req.body;

    // Check if page exists
    const pageDoc = await db.collection('cms_pages').doc(pageId).get();

    if (!pageDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Page not found',
        data: null,
        error: { code: 'PAGE_NOT_FOUND' }
      });
    }

    // Validate and filter updates
    const allowedFields = ['title', 'slug', 'content', 'status', 'metaDescription', 'metaKeywords'];
    const filteredUpdates = {};

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        // Validate slug if being updated
        if (key === 'slug' && !/^[a-z0-9-]+$/.test(value)) {
          return res.status(400).json({
            success: false,
            message: 'Slug must contain only lowercase letters, numbers, and hyphens',
            data: null,
            error: { code: 'INVALID_SLUG' }
          });
        }

        // Check for duplicate slug
        if (key === 'slug' && value !== pageDoc.data().slug) {
          const existingPage = await db.collection('cms_pages')
            .where('slug', '==', value)
            .get();

          if (!existingPage.empty) {
            return res.status(409).json({
              success: false,
              message: 'Page with this slug already exists',
              data: null,
              error: { code: 'DUPLICATE_SLUG' }
            });
          }
        }

        filteredUpdates[key] = value;
      }
    }

    if (Object.keys(filteredUpdates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update',
        data: null,
        error: { code: 'NO_UPDATES' }
      });
    }

    filteredUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    filteredUpdates.updatedBy = req.user.id;

    await db.collection('cms_pages').doc(pageId).update(filteredUpdates);

    const updatedPage = await db.collection('cms_pages').doc(pageId).get();

    res.json({
      success: true,
      message: 'Page updated successfully',
      data: {
        id: updatedPage.id,
        ...updatedPage.data()
      },
      error: null
    });
  } catch (error) {
    console.error('Update CMS page error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update page',
      data: null,
      error: { code: 'UPDATE_FAILED' }
    });
  }
});

// DELETE /api/v1/cms/pages/:pageId - Delete page (Admin only)
router.delete('/pages/:pageId', verifyToken, requireRole('admin', 'super_admin'), auditLog, async (req, res) => {
  try {
    const { pageId } = req.params;

    const pageDoc = await db.collection('cms_pages').doc(pageId).get();

    if (!pageDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Page not found',
        data: null,
        error: { code: 'PAGE_NOT_FOUND' }
      });
    }

    await db.collection('cms_pages').doc(pageId).delete();

    res.json({
      success: true,
      message: 'Page deleted successfully',
      data: null,
      error: null
    });
  } catch (error) {
    console.error('Delete CMS page error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete page',
      data: null,
      error: { code: 'DELETE_FAILED' }
    });
  }
});

module.exports = router;