// Protobuf module tree for Overdraft Aqua substreams.
#[rustfmt::skip]
#[path = "overdraft.aqua.v1.rs"]
pub mod overdraft_aqua_v1;

// Re-export under a path that matches the proto package (overdraft.aqua.v1),
// so `crate::pb::overdraft::aqua::v1` resolves like CLI-generated code.
pub mod overdraft {
    pub mod aqua {
        pub use crate::pb::overdraft_aqua_v1 as v1;
    }
}
