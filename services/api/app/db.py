from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

cfg = settings()
Path(cfg.data_dir).mkdir(parents=True, exist_ok=True)
engine = create_engine(
    cfg.database_url,
    pool_pre_ping=True,
    **(
        {"pool_size": cfg.db_pool_size, "max_overflow": cfg.db_max_overflow}
        if not cfg.database_url.startswith("sqlite")
        else {}
    ),
    connect_args={"check_same_thread": False} if cfg.database_url.startswith("sqlite") else {},
)
if engine.dialect.name == "sqlite":

    @event.listens_for(engine, "connect")
    def enable_fk(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    with SessionLocal() as db:
        yield db
