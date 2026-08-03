# Trained model checkpoints

Drop your downloaded `best.pt` (from the Kaggle training notebook's Output tab)
right here:

    training/models/best.pt

Then run the local inference server from the `training/` directory:

    python -m src.server --checkpoint models/best.pt

The path is just a command-line argument, so a checkpoint can live anywhere —
this folder is the recommended, tidy default.

Note: checkpoints are large (~70 MB for EfficientNet-B4) and are build
artifacts, not source — no need to keep them under version control.
