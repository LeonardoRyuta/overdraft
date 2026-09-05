// Generated-equivalent prost types for proto/overdraft.proto
// (package overdraft.aqua.v1).
//
// Hand-maintained to match proto/overdraft.proto field-for-field so the crate
// builds with plain `cargo build` (no protoc/buf needed on Windows). If you
// change the .proto, regenerate this with `substreams protogen` on Linux/macOS,
// or `buf generate`, and drop the result in here. Field numbers are the wire
// contract — keep them in sync with the .proto.

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Events {
    #[prost(message, repeated, tag = "1")]
    pub shipped: ::prost::alloc::vec::Vec<ShippedEvent>,
    #[prost(message, repeated, tag = "2")]
    pub pushed: ::prost::alloc::vec::Vec<PushedEvent>,
    #[prost(message, repeated, tag = "3")]
    pub pulled: ::prost::alloc::vec::Vec<PulledEvent>,
    #[prost(message, repeated, tag = "4")]
    pub docked: ::prost::alloc::vec::Vec<DockedEvent>,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct EventMeta {
    #[prost(uint64, tag = "1")]
    pub block_number: u64,
    #[prost(string, tag = "2")]
    pub block_hash: ::prost::alloc::string::String,
    #[prost(uint64, tag = "3")]
    pub block_timestamp: u64,
    #[prost(string, tag = "4")]
    pub tx_hash: ::prost::alloc::string::String,
    #[prost(uint32, tag = "5")]
    pub log_index: u32,
    #[prost(uint32, tag = "6")]
    pub log_ordinal: u32,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct ShippedEvent {
    #[prost(message, optional, tag = "1")]
    pub meta: ::core::option::Option<EventMeta>,
    #[prost(string, tag = "2")]
    pub maker: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub app: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub strategy_hash: ::prost::alloc::string::String,
    #[prost(string, tag = "5")]
    pub strategy: ::prost::alloc::string::String,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PushedEvent {
    #[prost(message, optional, tag = "1")]
    pub meta: ::core::option::Option<EventMeta>,
    #[prost(string, tag = "2")]
    pub maker: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub app: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub strategy_hash: ::prost::alloc::string::String,
    #[prost(string, tag = "5")]
    pub token: ::prost::alloc::string::String,
    #[prost(string, tag = "6")]
    pub amount: ::prost::alloc::string::String,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct PulledEvent {
    #[prost(message, optional, tag = "1")]
    pub meta: ::core::option::Option<EventMeta>,
    #[prost(string, tag = "2")]
    pub maker: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub app: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub strategy_hash: ::prost::alloc::string::String,
    #[prost(string, tag = "5")]
    pub token: ::prost::alloc::string::String,
    #[prost(string, tag = "6")]
    pub amount: ::prost::alloc::string::String,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct DockedEvent {
    #[prost(message, optional, tag = "1")]
    pub meta: ::core::option::Option<EventMeta>,
    #[prost(string, tag = "2")]
    pub maker: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub app: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub strategy_hash: ::prost::alloc::string::String,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct EntityChanges {
    #[prost(message, repeated, tag = "1")]
    pub makers: ::prost::alloc::vec::Vec<Maker>,
    #[prost(message, repeated, tag = "2")]
    pub tokens: ::prost::alloc::vec::Vec<Token>,
    #[prost(message, repeated, tag = "3")]
    pub positions: ::prost::alloc::vec::Vec<Position>,
    #[prost(message, repeated, tag = "4")]
    pub commitments: ::prost::alloc::vec::Vec<Commitment>,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Maker {
    #[prost(string, tag = "1")]
    pub id: ::prost::alloc::string::String,
    #[prost(uint64, tag = "2")]
    pub first_seen_block: u64,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Token {
    #[prost(string, tag = "1")]
    pub id: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub symbol: ::prost::alloc::string::String,
    #[prost(int32, tag = "3")]
    pub decimals: i32,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Position {
    #[prost(string, tag = "1")]
    pub id: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub maker: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub app: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub strategy_hash: ::prost::alloc::string::String,
    #[prost(bool, tag = "5")]
    pub active: bool,
    #[prost(string, repeated, tag = "6")]
    pub tokens: ::prost::alloc::vec::Vec<::prost::alloc::string::String>,
    #[prost(uint64, tag = "7")]
    pub shipped_block: u64,
    #[prost(string, tag = "8")]
    pub shipped_tx: ::prost::alloc::string::String,
    #[prost(uint64, tag = "9")]
    pub docked_block: u64,
    #[prost(bool, tag = "10")]
    pub docked_block_set: bool,
}

#[allow(clippy::derive_partial_eq_without_eq)]
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Commitment {
    #[prost(string, tag = "1")]
    pub id: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub position: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub maker: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub token: ::prost::alloc::string::String,
    #[prost(string, tag = "5")]
    pub committed: ::prost::alloc::string::String,
    #[prost(bool, tag = "6")]
    pub active: bool,
    #[prost(uint64, tag = "7")]
    pub last_updated_block: u64,
}
