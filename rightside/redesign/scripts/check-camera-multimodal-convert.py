#!/usr/bin/env python3
"""Same-model local Core ML feasibility and numeric parity. No model/operation substitution."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import sys
import time

os.environ.setdefault("OMP_NUM_THREADS","1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS","1")
import cv2
import numpy as np
import onnx
import onnxruntime as ort
import torch
import coremltools as ct
import yaml
from onnx2torch import convert

p=argparse.ArgumentParser()
p.add_argument("root",type=Path)
p.add_argument("output",type=Path)
a=p.parse_args()
assert not json.loads((a.root.parent/"docs/hill-climb/STATE.json").read_text())["stopRequested"]
torch.set_num_threads(1);torch.set_num_interop_threads(1);cv2.setNumThreads(1)
assets=a.root/"dist/hill-climb-b3/paddle-assets"
onnx_path=assets/"inference.onnx"
assert hashlib.sha256(onnx_path.read_bytes()).hexdigest()=="7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498"
dictionary=[""]+yaml.safe_load((assets/"inference.yml").read_text())["PostProcess"]["character_dict"]+[" "]
a.output.mkdir(parents=True,exist_ok=True)
(a.output/"display-characters.json").write_text(json.dumps(dictionary,ensure_ascii=False))
report={"modelSHA256":hashlib.sha256(onnx_path.read_bytes()).hexdigest(),"versions":{"onnx":onnx.__version__,"onnxruntime":ort.__version__,"torch":torch.__version__,"coremltools":ct.__version__},"cases":[],"warnings":"See full compile/conversion log; none suppressed"}
def save():
    report["peakResidentBytes"]=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    (a.output/"parity.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
def failed(kind,value,traceback):
    report["failure"]={"type":kind.__name__,"message":str(value)}
    save()
    sys.__excepthook__(kind,value,traceback)
sys.excepthook=failed
def decode(values):
    assert values.ndim==3 and values.shape[0]==1 and values.shape[2]==len(dictionary)
    indices=values[0].argmax(axis=1)
    return "".join(dictionary[int(v)] for i,v in enumerate(indices) if v!=0 and (i==0 or v!=indices[i-1]))
old=json.loads((a.root/"dist/hill-climb-b3/paddle.e0qch6nx/report.json").read_text())
# Deterministic declared controls: all unpadded observed crop rows, plus black/gray textures.
# No expected transcription is consulted when choosing pixels or comparing engine outputs.
cases=[]
for row in old["rows"]:
    if row.get("padding")==0:
        image=cv2.imread(str(a.root/"evaluation/images"/(row["sample"]+".jpg")))
        scale=min(1,row["sceneLongestSide"]/max(image.shape[:2]))
        image=cv2.resize(image,(round(image.shape[1]*scale),round(image.shape[0]*scale)))
        x,y,w,h=row["cropPixels"];crop=image[y:y+h,x:x+w]
        width=min(320,max(1,math.ceil(48*w/h)))
        tensor=np.zeros((1,3,48,320),dtype=np.float32)
        tensor[0,:,:,:width]=cv2.resize(crop,(width,48)).astype(np.float32).transpose(2,0,1)/127.5-1
        cases.append((row["sample"]+"-"+str(row["sceneLongestSide"])+"-proposal"+str(row["proposalIndex"]),tensor))
for value in [0,127]:cases.append(("uniform-"+str(value),np.full((1,3,48,320),value/127.5-1,dtype=np.float32)))
assert len(cases)<=16
options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1;options.enable_mem_pattern=False
session=ort.InferenceSession(str(onnx_path),sess_options=options,providers=["CPUExecutionProvider"])
references=[]
for i,(name,tensor) in enumerate(cases):
    frozen=a.root/"dist/hill-climb-b3/conversion.j8jyrxsi"/("input-"+str(i)+".float32")
    if frozen.exists():
        assert hashlib.sha256(tensor.astype("<f4").tobytes()).digest()==hashlib.sha256(frozen.read_bytes()).digest(),"Frozen input changed: "+name
    reference=session.run(None,{session.get_inputs()[0].name:tensor})[0]
    references.append(reference)
    tensor.astype("<f4").tofile(a.output/ ("input-"+str(i)+".float32"))
    reference.astype("<f4").tofile(a.output/("reference-"+str(i)+".float32"))
    report["cases"].append({"name":name,"shape":list(reference.shape),"onnxText":decode(reference),
        "inputSHA256":hashlib.sha256(tensor.astype("<f4").tobytes()).hexdigest(),
        "originalORTOutputSHA256":hashlib.sha256(reference.astype("<f4").tobytes()).hexdigest()})
del session
save()
started=time.monotonic()
graph=onnx.load(str(onnx_path))
# The converter lacks some old opset7 registrations. Use ONNX's explicit semantic
# version adapters, retaining the transformed graph; parity remains against ORIGINAL7.
# This is not removal/replacement of unsupported computation or changing model weights.
graph=onnx.version_converter.convert_version(graph,13)
onnx.checker.check_model(graph)
onnx.save(graph,str(a.output/"semantic-opset13.onnx"))
report["semanticVersionAdaptation"]={"from":7,"to":13,"tool":"onnx.version_converter1.17.0",
    "sha256":hashlib.sha256((a.output/"semantic-opset13.onnx").read_bytes()).hexdigest(),"nodeCount":len(graph.graph.node)}
# onnx2torch's Conv loader only accepts initializer weights. Canonicalize ONLY
# literal Constant tensors and Identity aliases of those proven static values.
# Preserve every other node and retain exact tensor hashes and the canonical graph.
nodes=list(graph.graph.node)
known={t.name:t for t in graph.graph.initializer}
added=[];removed=set();folds=[]
for i,node in enumerate(nodes):
    if node.op_type=="Constant" and not node.input and len(node.output)==1 and len(node.attribute)==1:
        attribute=node.attribute[0]
        if attribute.name=="value" and attribute.type==onnx.AttributeProto.TENSOR:
            tensor=onnx.TensorProto();tensor.CopyFrom(attribute.t);tensor.name=node.output[0]
            assert tensor.name not in known
            known[tensor.name]=tensor;added.append(tensor);removed.add(i)
            folds.append({"operation":"literal Constant→initializer","output":tensor.name,
                "tensorSHA256":hashlib.sha256(tensor.SerializeToString()).hexdigest()})
while True:
    previous=len(removed)
    for i,node in enumerate(nodes):
        if i not in removed and node.op_type=="Identity" and len(node.input)==1 and len(node.output)==1 and node.input[0] in known:
            tensor=onnx.TensorProto();tensor.CopyFrom(known[node.input[0]]);tensor.name=node.output[0]
            assert tensor.name not in known
            known[tensor.name]=tensor;added.append(tensor);removed.add(i)
            folds.append({"operation":"static Identity→initializer","input":node.input[0],"output":tensor.name,
                "tensorSHA256":hashlib.sha256(tensor.SerializeToString()).hexdigest()})
    if len(removed)==previous:break
del graph.graph.node[:]
graph.graph.node.extend(node for i,node in enumerate(nodes) if i not in removed)
graph.graph.initializer.extend(added)
# IR3 requires initializers to be listed as caller inputs; IR4 permits fixed internal
# initializer constants. Keep the original x-only interface, explicitly record this
# representation change, and still compare all outputs against original IR3/opset7.
report["initializerRepresentationIR"]={"from":graph.ir_version,"to":max(4,graph.ir_version),"reason":"fixed internal initializers without new caller inputs"}
graph.ir_version=max(4,graph.ir_version)
onnx.save(graph,str(a.output/"canonical-static.onnx"))
report["staticCanonicalization"]={"folds":folds,"remainingNodeCount":len(graph.graph.node),
    "sha256":hashlib.sha256((a.output/"canonical-static.onnx").read_bytes()).hexdigest(),
    "inputSHA256":hashlib.sha256(b"".join(t.SerializeToString() for t in graph.graph.input)).hexdigest(),
    "operationSHA256":hashlib.sha256(b"".join(t.SerializeToString() for t in graph.graph.node)).hexdigest(),
    "initializerSHA256":{t.name:hashlib.sha256(t.SerializeToString()).hexdigest() for t in graph.graph.initializer}}
save()
onnx.checker.check_model(graph)
report["canonicalSchemaPassed"]=True
save()
# Pin the already-declared deployment shape and regenerate missing intermediate TYPE
# metadata. No operation or parameter changes; preserve both graphs and verify this.
before_operations=[n.SerializeToString() for n in graph.graph.node]
before_initializers={t.name:t.SerializeToString() for t in graph.graph.initializer}
assert len(graph.graph.input)==1 and graph.graph.input[0].name=="x"
graph.graph.input[0].CopyFrom(onnx.helper.make_tensor_value_info("x",onnx.TensorProto.FLOAT,[1,3,48,320]))
removed_type_annotations=len(graph.graph.value_info)
del graph.graph.value_info[:]
graph=onnx.shape_inference.infer_shapes(graph,strict_mode=True,data_prop=True)
onnx.checker.check_model(graph)
assert [n.SerializeToString() for n in graph.graph.node]==before_operations
assert {t.name:t.SerializeToString() for t in graph.graph.initializer}==before_initializers
types={v.name:v for v in list(graph.graph.value_info)+list(graph.graph.input)+list(graph.graph.output)}
weights={t.name:t for t in graph.graph.initializer}
rank_facts=[]
# Official inference cannot always propagate rank through Shape/Concat-driven Reshape.
# ONNX Conv's output rank equals its fixed weight rank, and output channels equal W[0].
# Supply ONLY those provable type facts, leaving batch/spatial dimensions unknown.
# No runtime shape values, operators or weights are replaced by guessed values.
for node in graph.graph.node:
    if node.op_type=="Conv" and node.input[1] in weights:
        output=node.output[0];weight=weights[node.input[1]]
        existing=types.get(output)
        if existing is not None and len(existing.type.tensor_type.shape.dim)==0:
            rank=len(weight.dims)
            assert rank in [3,4,5]
            dims=[None,int(weight.dims[0])]+[None]*(rank-2)
            existing.CopyFrom(onnx.helper.make_tensor_value_info(output,weight.data_type,dims))
            rank_facts.append({"output":output,"operator":"Conv","weight":weight.name,"weightDimensions":list(weight.dims),
                "weightSHA256":hashlib.sha256(weight.SerializeToString()).hexdigest(),"outputDimensions":dims})
graph=onnx.shape_inference.infer_shapes(graph,strict_mode=True,data_prop=True)
onnx.checker.check_model(graph)
assert [n.SerializeToString() for n in graph.graph.node]==before_operations
assert {t.name:t.SerializeToString() for t in graph.graph.initializer}==before_initializers
types={v.name:v for v in list(graph.graph.value_info)+list(graph.graph.input)+list(graph.graph.output)}
batch_norm_ranks=[len(types[n.input[0]].type.tensor_type.shape.dim) for n in graph.graph.node if n.op_type=="BatchNormalization"]
assert len(batch_norm_ranks)==6 and all(rank==4 for rank in batch_norm_ranks),batch_norm_ranks
onnx.save(graph,str(a.output/"canonical-shaped.onnx"))
report["shapeSpecialization"]={"input":[1,3,48,320],"tool":"onnx.shape_inference1.17.0",
    "removedTypeAnnotations":removed_type_annotations,"batchNormInputRanks":batch_norm_ranks,
    "convSchemaRankFacts":rank_facts,
    "operationsByteIdentical":True,"initializersByteIdentical":True,
    "sha256":hashlib.sha256((a.output/"canonical-shaped.onnx").read_bytes()).hexdigest()}
save()
canonical=ort.InferenceSession(str(a.output/"canonical-shaped.onnx"),sess_options=options,providers=["CPUExecutionProvider"])
for row,(_,tensor),reference in zip(report["cases"],cases,references):
    output=canonical.run(None,{canonical.get_inputs()[0].name:tensor})[0]
    row["canonicalMaxAbsoluteError"]=float(np.max(np.abs(output-reference)))
    row["canonicalMeanAbsoluteError"]=float(np.mean(np.abs(output-reference)))
    row["canonicalText"]=decode(output)
    assert row["canonicalMaxAbsoluteError"]<0.001 and row["canonicalMeanAbsoluteError"]<0.0001 and row["canonicalText"]==row["onnxText"],row
del canonical
save()
model=convert(graph).eval()
report["torchConversionSeconds"]=time.monotonic()-started
with torch.no_grad():
    for row,(_,tensor),reference in zip(report["cases"],cases,references):
        output=model(torch.from_numpy(tensor)).detach().numpy()
        row["torchMaxAbsoluteError"]=float(np.max(np.abs(output-reference)))
        row["torchMeanAbsoluteError"]=float(np.mean(np.abs(output-reference)))
        row["torchText"]=decode(output)
        assert row["torchMaxAbsoluteError"]<0.001 and row["torchMeanAbsoluteError"]<0.0001 and row["torchText"]==row["onnxText"],row
    traced=torch.jit.trace(model,torch.from_numpy(cases[0][1]),strict=True)
save()
convert_at=time.monotonic()
converted=ct.convert(traced,convert_to="mlprogram",inputs=[ct.TensorType(name="input",shape=(1,3,48,320))],
    outputs=[ct.TensorType(name="scores")],minimum_deployment_target=ct.target.iOS17,
    compute_precision=ct.precision.FLOAT32,compute_units=ct.ComputeUnit.CPU_ONLY,skip_model_load=True)
report["coreMLConversionSeconds"]=time.monotonic()-convert_at
converted.author="PaddlePaddle authors; local same-model conversion by RightSide"
converted.license="Apache-2.0; see retained PaddleOCR-LICENSE.txt"
converted.short_description="Pinned latin_PP-OCRv5_mobile_rec, BGR 48x320, greedy CTC; development camera evidence"
converted.user_defined_metadata["sourceONNXSHA256"]=report["modelSHA256"]
converted.user_defined_metadata["configID"]="bgr-linear-48-ctc-unpadded-v1"
converted.user_defined_metadata["dictionarySHA256"]=hashlib.sha256((a.output/"display-characters.json").read_bytes()).hexdigest()
converted.save(str(a.output/"VehicleDisplayRecognizer.mlpackage"))
save()
compile_at=time.monotonic()
compiled_path=ct.models.utils.compile_model(str(a.output/"VehicleDisplayRecognizer.mlpackage"),destination_path=str(a.output/"VehicleDisplayRecognizer.mlmodelc"))
report["coreMLColdCompileSeconds"]=time.monotonic()-compile_at
load_at=time.monotonic()
runtime=ct.models.CompiledMLModel(compiled_path,compute_units=ct.ComputeUnit.CPU_ONLY)
report["coreMLColdLoadSeconds"]=time.monotonic()-load_at
for row,(_,tensor),reference in zip(report["cases"],cases,references):
    prediction_at=time.monotonic()
    output=runtime.predict({"input":tensor})["scores"]
    row["coreMLPredictionMS"]=(time.monotonic()-prediction_at)*1000
    row["coreMLShape"]=list(output.shape)
    assert output.shape==reference.shape
    row["coreMLMaxAbsoluteError"]=float(np.max(np.abs(output-reference)))
    row["coreMLMeanAbsoluteError"]=float(np.mean(np.abs(output-reference)))
    row["coreMLText"]=decode(output)
    row["passed"]=row["coreMLMaxAbsoluteError"]<0.001 and row["coreMLMeanAbsoluteError"]<0.0001 and row["coreMLText"]==row["onnxText"]
    print(json.dumps(row,ensure_ascii=False),flush=True);save()
report["passed"]=all(r["passed"] for r in report["cases"])
report["conversionAndParitySeconds"]=time.monotonic()-started
save()
raise SystemExit(0 if report["passed"] else 1)
