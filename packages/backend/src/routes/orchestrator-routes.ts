import { Router } from 'express';
import { listTriggers, cancelTrigger } from '../services/db.js';
import type { Orchestrator } from '../services/orchestrator.js';

export function createOrchestratorRoutes(): Router {
  const router = Router();

  // Get orchestrator task status
  router.get('/orchestrator/status', async (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      const tasks = await orchestrator.getStatus();
      res.json({ tasks });
    } catch (error) {
      console.error('Error fetching orchestrator status:', error);
      res.status(500).json({ error: 'Failed to fetch orchestrator status' });
    }
  });

  // Enable/disable/reschedule a task
  router.patch('/orchestrator/tasks/:wakeType', async (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }

      const { wakeType } = req.params;
      const { enabled, cronExpr } = req.body;

      if (cronExpr !== undefined) {
        if (typeof cronExpr !== 'string') {
          res.status(400).json({ error: 'cronExpr must be a string' });
          return;
        }
        const success = orchestrator.rescheduleTask(wakeType, cronExpr);
        if (!success) {
          res.status(400).json({ error: 'Failed to reschedule — invalid cron expression or unknown task' });
          return;
        }
      }

      if (enabled !== undefined) {
        if (typeof enabled !== 'boolean') {
          res.status(400).json({ error: 'enabled must be a boolean' });
          return;
        }
        const success = enabled
          ? orchestrator.enableTask(wakeType)
          : orchestrator.disableTask(wakeType);
        if (!success) {
          res.status(404).json({ error: 'Unknown task' });
          return;
        }
      }

      const tasks = await orchestrator.getStatus();
      res.json({ success: true, tasks });
    } catch (error) {
      console.error('Error updating orchestrator task:', error);
      res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // Get failsafe config
  router.get('/orchestrator/failsafe', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }
      res.json(orchestrator.getFailsafeConfig());
    } catch (error) {
      console.error('Error fetching failsafe config:', error);
      res.status(500).json({ error: 'Failed to fetch failsafe config' });
    }
  });

  // Update failsafe config
  router.patch('/orchestrator/failsafe', (req, res) => {
    try {
      const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
      if (!orchestrator) {
        res.status(503).json({ error: 'Orchestrator not available' });
        return;
      }

      const { enabled, gentle, concerned, emergency } = req.body;
      orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
      res.json({ success: true, ...orchestrator.getFailsafeConfig() });
    } catch (error) {
      console.error('Error updating failsafe config:', error);
      res.status(500).json({ error: 'Failed to update failsafe config' });
    }
  });

  // Get active triggers
  router.get('/orchestrator/triggers', (req, res) => {
    try {
      const kind = req.query.kind as 'impulse' | 'watcher' | undefined;
      const triggers = listTriggers(kind);
      res.json({ triggers });
    } catch (error) {
      console.error('Error fetching triggers:', error);
      res.status(500).json({ error: 'Failed to fetch triggers' });
    }
  });

  // Cancel a trigger
  router.delete('/orchestrator/triggers/:id', (req, res) => {
    try {
      const cancelled = cancelTrigger(req.params.id);
      if (!cancelled) {
        res.status(404).json({ error: 'Trigger not found or already cancelled' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error cancelling trigger:', error);
      res.status(500).json({ error: 'Failed to cancel trigger' });
    }
  });

  return router;
}
