from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class ConversationCreateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=200)


class ConversationUpdateRequest(BaseModel):
    title: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
    ]


class ConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str | None
    created_at: datetime
    updated_at: datetime


class MessageCreateRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    conversation_id: UUID
    role: str
    content: str
    created_at: datetime


class ChatTurnResponse(BaseModel):
    user_message: MessageResponse
    assistant_message: MessageResponse
