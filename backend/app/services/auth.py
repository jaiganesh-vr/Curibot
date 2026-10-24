from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password, verify_password
from app.models import User


class UserAlreadyExistsError(Exception):
    """Raised when a registration email is already in use."""


class InvalidCredentialsError(Exception):
    """Raised when login credentials are invalid."""


def register_user(db: Session, email: str, password: str) -> User:
    """Create a user while safely handling duplicate email addresses."""
    normalized_email = email.strip().lower()

    existing_user = db.scalar(select(User).where(User.email == normalized_email))
    if existing_user is not None:
        raise UserAlreadyExistsError

    user = User(
        email=normalized_email,
        hashed_password=hash_password(password),
    )
    db.add(user)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        existing_user = db.scalar(select(User).where(User.email == normalized_email))
        if existing_user is not None:
            raise UserAlreadyExistsError from exc
        raise

    db.refresh(user)
    return user


def authenticate_user(
    db: Session,
    email: str,
    password: str,
) -> User:
    """Verify credentials and return an active user."""
    normalized_email = email.strip().lower()

    user = db.scalar(select(User).where(User.email == normalized_email))

    if (
        user is None
        or not user.is_active
        or not verify_password(password, user.hashed_password)
    ):
        raise InvalidCredentialsError

    return user
