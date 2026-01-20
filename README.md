# biq-streamer

Solana transaction streamer using websocket `slotsUpdatesSubscribe` and `getBlock` standard RPC call.

Slot updates which can be used for tracking the live progress of a cluster:

- **firstShredReceived**: connected node received the first shred of a block. Indicates that a new block that is being produced.
- **completed**: connected node has received all shreds of a block. Indicates a block was recently produced.
- **optimisticConfirmation**: block was optimistically confirmed by the cluster. It is not guaranteed that an optimistic confirmation notification will be sent for every finalized blocks.
- **root**: the connected node rooted this block.
- **createdBank**: the connected node has started validating this block.
- **frozen**: the connected node has validated this block.
- **dead**: the connected node failed to validate this block.
