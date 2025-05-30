"""
Scheduler database service for Aurora.
Handles all database operations related to cron jobs.
"""

import aiosqlite
from datetime import datetime
from typing import List, Optional, Dict, Any
from pathlib import Path

from .models import CronJob, JobStatus, ScheduleType
from .migration_manager import MigrationManager


class SchedulerDatabaseService:
    """Database service for scheduler operations"""
    
    def __init__(self, db_path: str = None):
        if db_path is None:
            # Default to data directory in project root
            project_root = Path(__file__).parent.parent.parent
            data_dir = project_root / "data"
            data_dir.mkdir(exist_ok=True)
            db_path = str(data_dir / "aurora.db")
        
        self.db_path = db_path
        
        # Set up migrations
        migrations_dir = Path(__file__).parent / "migrations"
        self.migration_manager = MigrationManager(db_path, str(migrations_dir))
    
    async def initialize(self):
        """Initialize the scheduler database and run migrations"""
        print(f"Initializing scheduler database at: {self.db_path}")
        
        # Ensure database file exists
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        
        # Run migrations
        await self.migration_manager.run_migrations()
        
        print("Scheduler database initialization completed")
    
    async def add_job(self, job: CronJob) -> bool:
        """Add a new job to the database"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                job_dict = job.to_dict()
                placeholders = ', '.join(['?' for _ in job_dict])
                columns = ', '.join(job_dict.keys())
                values = list(job_dict.values())
                
                await db.execute(f"""
                    INSERT INTO cron_jobs ({columns})
                    VALUES ({placeholders})
                """, values)
                await db.commit()
            
            print(f"Added job: {job.name} (next run: {job.next_run_time})")
            return True
            
        except Exception as e:
            print(f"Error adding job: {e}")
            return False
    
    async def update_job(self, job: CronJob) -> bool:
        """Update job in database"""
        try:
            job.updated_at = datetime.now()
            async with aiosqlite.connect(self.db_path) as db:
                job_dict = job.to_dict()
                set_clause = ', '.join([f"{k} = ?" for k in job_dict.keys() if k != 'id'])
                values = [v for k, v in job_dict.items() if k != 'id'] + [job.id]
                
                await db.execute(f"""
                    UPDATE cron_jobs 
                    SET {set_clause}
                    WHERE id = ?
                """, values)
                await db.commit()
            
            return True
            
        except Exception as e:
            print(f"Error updating job: {e}")
            return False
    
    async def get_job(self, job_id: str) -> Optional[CronJob]:
        """Get a job by ID"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM cron_jobs WHERE id = ?", (job_id,))
                row = await cursor.fetchone()
                
                if row:
                    return CronJob.from_dict(dict(row))
                return None
                
        except Exception as e:
            print(f"Error getting job: {e}")
            return None
    
    async def get_all_jobs(self) -> List[CronJob]:
        """Get all jobs"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM cron_jobs ORDER BY created_at DESC")
                rows = await cursor.fetchall()
                
                return [CronJob.from_dict(dict(row)) for row in rows]
                
        except Exception as e:
            print(f"Error getting all jobs: {e}")
            return []
    
    async def get_active_jobs(self) -> List[CronJob]:
        """Get all active jobs"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("""
                    SELECT * FROM cron_jobs 
                    WHERE is_active = 1
                    ORDER BY next_run_time ASC
                """)
                rows = await cursor.fetchall()
                
                return [CronJob.from_dict(dict(row)) for row in rows]
                
        except Exception as e:
            print(f"Error getting active jobs: {e}")
            return []
    
    async def get_ready_jobs(self) -> List[CronJob]:
        """Get jobs that are ready to execute"""
        try:
            now = datetime.now().isoformat()
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("""
                    SELECT * FROM cron_jobs 
                    WHERE is_active = 1 
                    AND next_run_time <= ?
                    AND status IN ('pending', 'failed')
                    ORDER BY next_run_time ASC
                """, (now,))
                rows = await cursor.fetchall()
                
                jobs = [CronJob.from_dict(dict(row)) for row in rows]
                # Filter by retry logic
                return [job for job in jobs if job.is_ready_to_run()]
                
        except Exception as e:
            print(f"Error getting ready jobs: {e}")
            return []
    
    async def delete_job(self, job_id: str) -> bool:
        """Delete a job"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute("DELETE FROM cron_jobs WHERE id = ?", (job_id,))
                await db.commit()
            
            print(f"Deleted job: {job_id}")
            return True
            
        except Exception as e:
            print(f"Error deleting job: {e}")
            return False
    
    async def deactivate_job(self, job_id: str) -> bool:
        """Deactivate a job"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute("""
                    UPDATE cron_jobs 
                    SET is_active = 0, updated_at = ?
                    WHERE id = ?
                """, (datetime.now().isoformat(), job_id))
                await db.commit()
            
            print(f"Deactivated job: {job_id}")
            return True
            
        except Exception as e:
            print(f"Error deactivating job: {e}")
            return False
    
    async def get_job_history(self, limit: int = 50) -> List[CronJob]:
        """Get job execution history"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("""
                    SELECT * FROM cron_jobs 
                    WHERE last_run_time IS NOT NULL
                    ORDER BY last_run_time DESC
                    LIMIT ?
                """, (limit,))
                rows = await cursor.fetchall()
                
                return [CronJob.from_dict(dict(row)) for row in rows]
                
        except Exception as e:
            print(f"Error getting job history: {e}")
            return []
    
    async def cleanup_old_jobs(self, days_to_keep: int = 30) -> int:
        """Remove completed/failed jobs older than specified days"""
        try:
            cutoff_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            cutoff_date = cutoff_date.replace(day=cutoff_date.day - days_to_keep)
            
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute("""
                    DELETE FROM cron_jobs 
                    WHERE is_active = 0 
                    AND status IN ('completed', 'failed', 'cancelled')
                    AND updated_at < ?
                """, (cutoff_date.isoformat(),))
                await db.commit()
                return cursor.rowcount
                
        except Exception as e:
            print(f"Error cleaning up old jobs: {e}")
            return 0
