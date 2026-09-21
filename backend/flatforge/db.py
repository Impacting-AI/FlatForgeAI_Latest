import os, time, uuid
from pathlib import Path
from sqlalchemy import create_engine, String, Text, Float, Integer, ForeignKey, Index, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
DATA=Path(os.getenv('FLATFORGE_DATA','./data')).resolve();DATA.mkdir(parents=True,exist_ok=True)
URL=os.getenv('DATABASE_URL',f'sqlite:///{DATA}/flatforge.db')
engine=create_engine(URL,pool_pre_ping=True,connect_args={'check_same_thread':False,'timeout':30} if URL.startswith('sqlite') else {})
if URL.startswith('sqlite'):
 @event.listens_for(engine,'connect')
 def configure_sqlite(conn,_):
  conn.execute('PRAGMA foreign_keys=ON');conn.execute('PRAGMA journal_mode=WAL')
Session=sessionmaker(engine,expire_on_commit=False)
class Base(DeclarativeBase):pass
class Setting(Base):
 __tablename__='settings'
 key:Mapped[str]=mapped_column(String(100),primary_key=True)
 value:Mapped[str]=mapped_column(Text)
class Project(Base):
 __tablename__='projects'
 id:Mapped[str]=mapped_column(String(36),primary_key=True,default=lambda:str(uuid.uuid4()))
 name:Mapped[str]=mapped_column(String(160));client:Mapped[str]=mapped_column(String(160),default='')
 created:Mapped[float]=mapped_column(Float,default=time.time)
class Panel(Base):
 __tablename__='panels'
 id:Mapped[str]=mapped_column(String(36),primary_key=True,default=lambda:str(uuid.uuid4()))
 project_id:Mapped[str]=mapped_column(ForeignKey('projects.id'),index=True)
 filename:Mapped[str]=mapped_column(String(240));source_key:Mapped[str]=mapped_column(Text)
 status:Mapped[str]=mapped_column(String(32),default='QUEUED',index=True)
 settings:Mapped[str]=mapped_column(Text);overrides:Mapped[str]=mapped_column(Text,default='{}')
 report:Mapped[str]=mapped_column(Text,default='{}');artifacts:Mapped[str]=mapped_column(Text,default='{}')
 error:Mapped[str]=mapped_column(Text,default='');manual_value:Mapped[float|None]=mapped_column(Float,nullable=True)
 manual_axis:Mapped[str]=mapped_column(String(20),default='flat_width');revision:Mapped[int]=mapped_column(Integer,default=1)
 created:Mapped[float]=mapped_column(Float,default=time.time);updated:Mapped[float]=mapped_column(Float,default=time.time)
class Job(Base):
 __tablename__='jobs'
 id:Mapped[str]=mapped_column(String(36),primary_key=True,default=lambda:str(uuid.uuid4()))
 panel_id:Mapped[str]=mapped_column(ForeignKey('panels.id'),index=True)
 status:Mapped[str]=mapped_column(String(24),default='QUEUED');revision:Mapped[int]=mapped_column(Integer)
 owner:Mapped[str]=mapped_column(String(80),default='');created:Mapped[float]=mapped_column(Float,default=time.time)
 heartbeat:Mapped[float]=mapped_column(Float,default=0);attempts:Mapped[int]=mapped_column(Integer,default=0)
 log:Mapped[str]=mapped_column(Text,default='Queued for conversion.\n')
 __table_args__=(Index('ix_jobs_claim','status','created'),)
def init():Base.metadata.create_all(engine)
