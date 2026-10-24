from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser
from app.core.security import create_access_token
from app.db.session import get_db
from app.schemas.auth import (
    TokenResponse,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
)
from app.services.auth import (
    InvalidCredentialsError,
    UserAlreadyExistsError,
    authenticate_user,
    register_user,
)

router = APIRouter(prefix="/auth", tags=["authentication"])


@router.post(
    "/login",
    response_model=TokenResponse,
    status_code=status.HTTP_200_OK,
)
def login(
    request: UserLoginRequest,
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    try:
        user = authenticate_user(
            db=db,
            email=str(request.email),
            password=request.password,
        )
    except InvalidCredentialsError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None

    token = create_access_token(subject=str(user.id))
    return TokenResponse(access_token=token)


@router.get("/me", response_model=UserResponse)
def read_current_user(current_user: CurrentUser) -> UserResponse:
    """Return the authenticated user's public profile."""
    return UserResponse.model_validate(current_user)


@router.post(
    "/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
)
def register(
    request: UserRegisterRequest,
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    try:
        user = register_user(
            db=db,
            email=str(request.email),
            password=request.password,
        )
    except UserAlreadyExistsError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists.",
        ) from None

    return UserResponse.model_validate(user)
